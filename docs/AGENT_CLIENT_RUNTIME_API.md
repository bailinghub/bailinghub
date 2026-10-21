# Agent Client Runtime v1

Core 0.8.0 起提供的可选[任务控制](AGENT_TASK_CONTROL.md)为 turn 增加宿主 `task_binding` 和原样回显；已加入任务的 Session 不能省略，业务搜索须使用原 `run_id`。原调用只读核对与显式继续分别处理。

本版本化接口让已完成 Agent Auth 网页授权的本地智能体在本地承担规划，同时继续复用 BailingHub 的身份重验、工具治理、审批、审计与对话总账。它不替代现有 `/run`、聊天入口或执行器协议。配套的部署、业务授权页和宿主接入步骤见 [Agent Client v1 接入指南](AGENT_CLIENT_QUICKSTART.md)，身份授权契约见 [Agent Auth v1](AGENT_AUTH_API.md)。

所有接口只接受 `Authorization: Bearer <Agent access token>`，响应均 `Cache-Control: no-store`。业务运行与能力接口的工作区授权面始终取以下交集：Client `allowed_routes` ∩ Agent Session `allowed_routes` ∩ 启用且 audience 允许的 route ∩ `tools.agent_direct`。`agent_client.enabled=false` 关闭 Runtime 工作区、上下文与能力接口，不关闭旧 `/agent-api/v1/tools`。

首次选择业务目标所需的[系统说明](AGENT_SYSTEM_INFO.md)采用同一身份与路由边界，但读取说明不要求开启 Runtime 或工具直调，也不会加载工具或创建业务运行。

## 端点

- `GET /agent-api/v1/workspaces`
- `GET /agent-api/v1/workspaces/:route/system-info`
- `GET /agent-api/v1/workspaces/:route/bootstrap`
- `POST /agent-api/v1/workspaces/:route/turns`
- `POST /agent-api/v1/workspaces/:route/capabilities/search`
- `POST /agent-api/v1/runs/:run_id/complete`
- 工具执行继续使用 `POST /agent-api/v1/tool-invocations` 与既有 resume 端点。

`turns` 与 `complete` 的原始 JSON 请求上限为 512 KiB。该上限可覆盖 64000 字符 Unicode 文本的 JSON 编码、Turn 的 16 KiB `page_context` 以及合理 envelope；解析后仍按各字段的字符上限严格校验。

工具调用的 `arguments` 必须是对象，按 `JSON.stringify(arguments)` 后的 UTF-8 字节数计量，最多 **1048576 字节（1 MiB）**。完整调用 HTTP JSON 信封最多 **2097152 字节（2 MiB）**；执行器的 `/jobs/:job_id/tools/invoke` 使用同一预算。它们是独立于 `BAILING_JSON_BODY_MAX_BYTES` 的工具调用固定安全预算，不改变其他接口或业务能力的字段上限。HTML/CSS 等复合字段继续传对象，由能力 schema 和业务服务独立校验，不能将其改成 JSON 字符串绕过校验。

超限在派发前返回 HTTP 413：`error=arguments_too_large`、`origin=core`、`dispatch=not_dispatched`、`limit_scope=arguments|request_body` 和 `max_bytes`。参数超限返回精确的 `actual_bytes`；HTTP 信封的流式读取超限返回 `observed_bytes`，仅代表停止读取前已观察到的字节数，完整请求可能更大。回执不包含正文或凭据。较旧 MCP/SDK 有独立的小上限，需要使用配套修复候选；只升级 Core 不会改变已安装客户端的校验。

完整审批参数快照与幂等哈希保持一致，通知只携带有界摘要；大快照在后台按需查看。放宽传输容量不会跳过主体、授权、审批、原调用幂等或审计约束。

## 工具审批语义

`tools.agent_direct.write_tools` 只负责按精确 operationId 开放本地 Agent 可调用的写工具；工具是否需要审批默认继续以业务侧 ACC 的 `risk`、`approval.required` 和 `approval.when` 声明为准。路由只有把工具精确列入 `tools.agent_direct.force_approval_tools` 时，才会在 ACC 之外额外强制审批。高风险、ACC 明示审批和条件审批不会被路由覆盖掉。

早期私有候选的 `unattended_write_tools` 仅保留兼容读取：存在该字段时，`write_tools` 中未列入它的工具仍按旧语义强制审批。新配置不得与 `force_approval_tools` 同时使用；删除旧字段表示默认继承 ACC，迁移为新字段时应填写旧 `write_tools` 与 `unattended_write_tools` 的差集，而不是原样复制旧列表。

## Bootstrap

```json
{
  "schema_version": "bailing.agent-runtime-profile.v1",
  "workspace": { "route": "tenant-agent", "name": "门店助手", "description": "" },
  "profile": {
    "revision": "<sha256>",
    "instructions": "【路由系统规则】\n...\n\n【本地 Agent 补充规则】\n...",
    "memory": { "recent_messages": 12, "recent_budget_chars": 8000, "per_message_chars": 2000, "summary_enabled": false, "summary_max_chars": 1200 },
    "knowledge": { "enabled": true, "sources": 1, "mode": "chunk", "top_k": 5, "max_docs": 4, "page_boost": false },
    "governance": {
      "planner": "local_agent",
      "execution": "bailinghub_governed",
      "authorization": "server_revalidated",
      "knowledge_trust": "reference_only",
      "tool_results_trust": "untrusted_data",
      "hidden_reasoning_sync": false,
      "max_tool_calls": 5,
      "permission": "full"
    }
  },
  "capabilities": { "revision": "<sha256>", "authorized_total": 312, "active_limit": 8, "readonly": 311, "writes": 1, "approval_required": 0 }
}
```

Bootstrap 只逐字段抽取 `target_config.system_prompt`，再拼接可选 `agent_client.instructions`。不会返回 `credential`、`model`、其他 `target_config`、ToolProvider base URL/secret 或业务工具出站配置。

## Turn

请求的四个标识/输入字段必填；`page_context` 与 `renderers` 可选。未知字段拒绝。
`user_input` 最多 64000 字符；`renderers` 最多 20 个，名称必须合法且不能重复。客户端文本出现不允许的控制字符、超长或非法 renderer 时直接返回 `400`，服务端不会截断、替换或静默丢弃。

```json
{
  "client_conversation_id": "local-conversation-1",
  "client_turn_id": "turn-1",
  "user_message_id": "message-1",
  "user_input": "帮我查一下员工 Ada",
  "page_context": { "url": "/staff", "title": "员工" },
  "renderers": ["markdown", "bailing-form.v1"]
}
```

```json
{
  "schema_version": "bailing.agent-turn-context.v1",
  "run_id": "<uuid>",
  "profile_revision": "<sha256>",
  "capability_revision": "<sha256>",
  "context": {
    "instructions": "...",
    "page_context": {},
    "renderers": [],
    "memory": { "summary": null, "recent": [] },
    "memory_refs": [{ "thread_id": 7, "summary_upto_id": 0, "prior_messages": 0 }],
    "knowledge": [{ "ref": "knowledge:1", "title": "...", "content": "..." }],
    "knowledge_refs": [{ "ref": "knowledge:1", "doc_id": 9, "title": "...", "score": 0.82 }],
    "governance": { "planner": "local_agent", "execution": "bailinghub_governed", "authorization": "server_revalidated", "knowledge_trust": "reference_only", "tool_results_trust": "untrusted_data", "hidden_reasoning_sync": false, "max_tool_calls": 5, "permission": "full" }
  },
  "active_tools": []
}
```

同一 Agent Session + route + conversation + turn，以及同一 `user_message_id`，会冻结到同一个 `run_id` 和上下文快照；同键不同请求返回 `409`。服务端先读取本轮之前的 memory，再把用户可见消息追加到总账。

能力搜索最多返回 12 个完整 typed tools，schema 为 `bailing.agent-capability-search.v1`。检索只在当前授权集内进行；任一工具源的 embedding 不可用时，整次搜索确定性退回 lexical 排序。
能力搜索必须提供非空 `query`，或者提供属于当前 Agent Session 与 route 的合法 `run_id`，由服务端回退使用该 run 的 `user_input`。

搜索响应新增可选 `discovery` 元数据，以下示例表示当前授权目录的 14 项候选中，本次返回排序靠前的 12 项：

```json
{
  "discovery": {
    "mode": "ranked_candidates",
    "scope": "current_authorization",
    "returned_count": 12,
    "authorized_total": 14,
    "matched_total": null,
    "matched_total_exact": false,
    "limit": 12,
    "truncated": true,
    "has_more": true,
    "truncation_scope": "authorized_catalog",
    "pagination": "unsupported"
  }
}
```

`authorized_total` 来自本次响应相同 `route`、`capability_revision` 对应的授权目录，已经过会话、路由、主体和直调策略裁剪。它不是系统全量能力数，也不是客户端会话共享的已加载工具数。`returned_count` 是本次 `tools.length`；`limit` 是实际返回上限。`truncated` / `has_more` 只表示授权候选因上限未全部返回，不表示还有确定匹配结果，也不提供下一页。

搜索按相关性排序，不过滤零分候选。例如查询库存时，已授权的订单工具仍可能作为后续候选返回；不能据返回数量断言系统具备或缺少某项能力。`matched_total` 为 `null`，精确性为 `false`，不可用 `0` 或返回数量代替。授权目录为空时，`returned_count` 和 `authorized_total` 均为 `0`，仍不代表其他授权范围没有能力。

这是现有 v1 响应的可选扩展；旧客户端可以忽略，新客户端遇到缺少 `discovery` 的旧服务端应把这些统计视为未知。搜索不修改 Core 权限或审批规则，宿主负责说明动态工具的替换/追加方式和当前有效的已加载工具。

## 工具调用与恢复

### 按名读取工具使用指导

发现结果中的 `description` 仍是短说明，OpenAPI 编译上限为 500 个 Unicode 字符。存在独立的完整说明时返回可选 `usage_guidance_available: true`；短说明确实超长时另返回 `description_truncated: true` 并产生 `tool_description_truncated` 编译警告。**有详细指导不等于短说明被截断**。OpenAPI 同时提供 `summary` 和 `description` 时，两者都会保留在按需指导中，原 `description` 不再因存在 `summary` 而丢失。

客户端可明确读取当前工具，不需要发起任务或业务调用：

```http
GET /agent-api/v1/tools/page_save?route=pages&capability_revision=<当前能力修订>
Authorization: Bearer <Agent access token>
```

响应为 `bailing.agent-tool-detail.v1`，包含同一 `route`、`capability_revision`、现有白名单投影 `tool`，以及 `usage_guidance: { text, truncated, source_chars, max_chars, source_bytes, max_bytes }`。`tool` 的 scope、风险、审批、只读、幂等等机器字段保持原语义；指导文字不会扩大权限或替代服务端校验。详情只合成标准 `summary`、`description`、ACC `when_to_use` / `returns` 和首个示例，不返回原 spec、扩展袋、Provider 地址或凭据。

指导同时受 **32768 个 Unicode code point** 和 **65536 个 UTF-8 字节**限制，先到者生效，保持完整字符。`source_chars` / `source_bytes` 是清理控制字符后的原始指导长度；`truncated: true` 明确表示详情也不完整，并产生 `tool_usage_guidance_truncated` 编译警告。接入方应缩短、前置关键条件；schema / ACC 中的机器约束继续独立执行。响应只按需携带一项指导，目录与搜索不会自动附上全文。

每次读取都重新检查当前 Client、Session、route、audience、主体与具体工具授权；旧修订返回 `409 capability_changed`，需重新发现。无当前工具授权返回 `404 tool_not_found`。该只读路径不创建 invocation/job、不消费审批或执行额度、不调用业务接口，且响应 `Cache-Control: no-store`。新增字段可被旧客户端忽略；遇到缺少字段或不支持详情端点的旧服务端时，不能宣称短说明已包含全部前置条件。

能力修订同时包含编译后的公开工具投影和有界指导，因此同一份原始 spec 经新编译器产生不同短说明、标记或指导时，也会使客户端缓存失效。该发现修订与 invocation 冻结的执行指纹分开：仅文案/指导变化不阻断原审批调用的恢复，也不会允许自动重复派发。

工具已经尝试发送、但网络中断或响应正文丢失时，Core 返回 `reconciliation_required` 和 `auto_retry_allowed: false`；只读和声明幂等的工具也不能被标为 `rejected_before_dispatch`。该状态表示尚无可信结果，不证明业务已经执行或尚未执行。

客户端必须保留原 `invocation_id` 及授权关联，使用现有 resume 恢复原调用。Core 重新验证当前授权并回放已保存的结果，不重新派发；结果仍不确定时需要人工核实，不能新建库存调整、订单更新等操作，也不能切换授权或改用另一工具重复执行。重新发现工具与恢复业务调用是两个动作。原审批和执行日志机制保持不变。

## Complete

授权级执行摘要可在既有 `content` 字符串中使用 `bailing.authorization-execution-summary.v1`：仅包含原 `invocation_id`、原工具名、`last_known_state`、未决调用的 `next_action: "inspect_original"`，以及 `total_invocations` / `omitted_invocations`。DSH 的新投影不把业务响应原文写入这份摘要；它也不是完整审计、当前结果验证或原文读取引用。

Core 装配下一轮 `memory.recent` 时，仅对出站消息识别该标识，重新白名单投影并固定标注 `kind: "authorization_execution_summary"`、`source: "agent_client"`、`trust: "reference_only"`。这是客户端报告的历史事实，标识本身不证明权限或结果；普通用户消息不会因出现同标识而获得执行来源。预算不足时按完整调用条目省略并标注数量；极小预算返回明确的省略说明，均不会产出半段 JSON。旧普通 assistant 正文保持兼容，既有 completion 幂等正文不会被静默改写；不新增用户长期记忆或审计全文存储承诺。

```json
{
  "assistant_message_id": "assistant-message-1",
  "status": "completed",
  "content": "已完成。",
  "model": "optional-model-name",
  "runtime": "optional-runtime-name",
  "usage": { "input_tokens": 120, "cached_input_tokens": 80, "output_tokens": 30, "total_tokens": 150, "tool_calls": 1 }
}
```

`assistant_message_id`、状态、可见正文、model/runtime/usage 共同参与幂等指纹；完全相同的重放返回 `200`，任一字段改变返回 `409`。接口不接收、不同步、也不落库 hidden reasoning。
`content` 最多 64000 字符，`model` 与 `runtime` 各最多 191 字符；超长或包含不允许控制字符时返回 `400`，不会静默规范化后落库。
