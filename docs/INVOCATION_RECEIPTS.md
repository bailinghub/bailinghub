# 原调用只读回执 / Read-only invocation receipts

## 中文使用说明

这是尚未公开发布的配套候选。比如，智能体为商城商品提交了上架请求，用户已批准，但客户端还没有继续执行。此时“看看进度”应只显示“已批准，尚未执行”。另一个常见场景是修改商品后连接中断，智能体需要查看原记录，判断中枢是否已经收到了结果。

本接口只查看原调用的结果、当前审批和执行日志。查询不执行上架、不消耗审批，也不改变原调用状态。`resume` 仍可能继续原操作，不能用来替代只读查询。回执中的 `business_operation_performed: false` 只表示这次查询没有执行业务，不表示原操作从未执行。

调用方必须保留原调用 ID 与原授权，查询时仍需通过当前权限校验。中枢全局暂停期间可以查询；授权撤销后不能换另一把授权读取。网络临时故障可以重试同一次查询；原记录找不到或结果仍未知时，应保留原 ID 核对，不能重新创建一次业务操作。

这一片无需数据库迁移，需使用配套 Core 和 SDK 候选。它提供后续任务视图需要的查询基础；任务累计预算、任务暂停按钮和 DSH 模型工具另行接入。下面给出具体请求、返回字段与兼容规则。

## Contract overview

An assistant may lose the confirmation for a product update, or reopen a conversation while a write is waiting for approval. Reading what the Hub already knows must not silently send the update again.

Invocation inspection reads the original Hub record, execution journal and approval state. It does not create a run, invoke a tool, consume an approval, decrypt frozen arguments, reserve a dispatch attempt, or change the original invocation state. This is a separate operation from `POST .../resume`, which may perform the original operation's first dispatch after approval or a confirmed rejection before dispatch.

## Negotiate support

Use the original Agent Session's Bearer token:

```http
GET /agent-api/v1/tool-invocations/inspection-capabilities
Authorization: Bearer <agent-access-token>
```

```json
{
  "schema_version": "bailing.agent-invocation-inspection-capabilities.v1",
  "receipt_schema": "bailing.agent-invocation-receipt.v1",
  "read_only": true
}
```

An older Hub that does not advertise this exact contract is unsupported. Do not substitute `resume`, invoke a replacement operation, or infer support from a package version. Negotiation authenticates the Agent Session without creating a business run or loading a tool catalog.

## Read the original receipt

```http
GET /agent-api/v1/tool-invocations/<original-64-hex-invocation-id>/receipt
Authorization: Bearer <original-agent-access-token>
```

Both GET endpoints accept no query parameters and return `Cache-Control: no-store`. The receipt endpoint accepts the original identifier only; it does not accept replacement arguments, a new target, a tool name, or a task identifier.

Example: an original update is waiting for its explicit continuation after approval:

```json
{
  "schema_version": "bailing.agent-invocation-receipt.v1",
  "read_only": true,
  "business_operation_performed": false,
  "invocation_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "agent_run_id": "22222222-2222-4222-8222-222222222222",
  "route": "catalog-agent",
  "tool": "product_update",
  "observed_at": "2026-09-15T00:00:00.000Z",
  "result": {
    "schema_version": "bailing.agent-tool-invocation.v1",
    "invocation_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "route": "catalog-agent",
    "tool": "product_update",
    "state": "awaiting_approval",
    "ok": false,
    "auto_retry_allowed": false,
    "text": "The governed tool invocation is awaiting approval.",
    "approval_id": 1
  },
  "result_source": "job",
  "dispatch_state": "not_dispatched",
  "approval": { "status": "approved", "approval_id": 1 },
  "journal_state": "absent"
}
```

The saved result and the latest approval observation intentionally remain distinct. Approval becoming `approved` does not make the business operation successful and inspection does not continue it.

## Interpret the observations

| Field | Meaning |
| --- | --- |
| `read_only`, `business_operation_performed` | This request only inspected records. These fields do not claim that the original operation never ran. |
| `invocation_id`, `agent_run_id`, `route`, `tool` | Original verified coordinates. A new user turn must not replace the original run or target. |
| `observed_at` | Observation time, not a dispatch permit or an atomic policy decision. |
| `result` | An allowlisted original invocation result, a projection of journal evidence, or `null` when no valid result is available. Raw job metadata and frozen arguments are excluded. |
| `result_source` | `job`, `journal`, or `none`. A completed journal can reveal a saved result even when the job still has an older prefix; inspection does not persist this projection. |
| `dispatch_state` | `not_dispatched` means existing evidence confirms a rejection or wait before dispatch; `attempted` means an execution attempt may have reached the business system; `unknown` means that distinction cannot be verified. `attempted` is not proof that the business system received or completed it. |
| `approval.status` | `none`, `pending`, `approved`, or `denied`; the latter three include the original `approval_id`. |
| `journal_state` | `absent`, `dispatching`, `response_recorded`, `completed`, `uncertain`, `evidence_degraded`, or `unknown`. `response_recorded` alone does not promise completion of the original execution evidence. |

Unresolved journal evidence projects `reconciliation_required` with `auto_retry_allowed: false`. Inspecting a malformed stored result returns `result: null`, not a fabricated success. A journal whose completion cannot be verified also remains unresolved.

The nested result preserves the existing invocation result contract. In particular, an old `auto_retry_allowed: true` describes that original result; it does not authorize the receipt consumer to automatically invoke or resume anything. Explicit continuation remains a distinct governed operation using the original invocation and original parameters.

These are observations of separately persisted records. A concurrent operation or approval can progress while they are read. Refresh the receipt to observe later evidence; never convert this read into a claim that it atomically grants or denies a future dispatch.

## Authorization and boundaries

- The original Agent Session must still be valid, the Client enabled, and the original route and specific tool currently authorized. Historical parameter schemas and execution fingerprints need not stay unchanged merely to inspect existing evidence.
- The Hub verifies the original job marker, Agent Session, Client, principal, subject and invocation coordinates. If the original runtime run exists, its session, client, route and thread association must also match. A missing historical runtime row is not reconstructed from conversation text.
- The host must retain and validate its complete original selected authorization set before using the original connection. This receipt API does not independently claim to implement a task's multi-member authorization ledger, cross-Hub access, or administrator audit permissions.
- Inspection works while the global Hub execution pause is enabled. Pause still blocks invoke and resume. Authentication can update the existing session `last_seen_at`; this does not update business data, invocation state, approval use, or the dispatch journal.
- Current authorization failure remains a failure. Do not fall back to another Agent Session, default authorization, remaining subset, or an administrator credential.
- An authenticated `invocation_not_found` is absence of a verifiable original record, not proof that a previous business write did not happen. Keep the original identifiers and inspect the original evidence through an authorized operator; do not issue a replacement write.

## Integration scope

This addition requires no database migration and leaves existing invoke/resume behavior unchanged. The Core endpoint and paired Agent Client SDK are a foundation for future task-level read views. No task record, cumulative task budget, task pause/cancel API, automatic reconciliation with a business provider, or task enforcement is introduced here.
