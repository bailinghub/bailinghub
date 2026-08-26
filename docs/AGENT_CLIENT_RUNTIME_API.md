# Agent Client Runtime v1（私有候选）

本接口让已完成 Agent Auth 网页授权的本地智能体在本地承担规划，同时继续复用 BailingHub 的身份重验、工具治理、审批、审计与对话总账。它不替代现有 `/run`、聊天入口或执行器协议，也不是公开稳定 API。

所有接口只接受 `Authorization: Bearer <Agent access token>`，响应均 `Cache-Control: no-store`。工作区授权面始终取以下交集：Client `allowed_routes` ∩ Agent Session `allowed_routes` ∩ 启用且 audience 允许的 route ∩ `tools.agent_direct`。`agent_client.enabled=false` 只关闭本页接口，不关闭旧 `/agent-api/v1/tools`。

## 端点

- `GET /agent-api/v1/workspaces`
- `GET /agent-api/v1/workspaces/:route/bootstrap`
- `POST /agent-api/v1/workspaces/:route/turns`
- `POST /agent-api/v1/workspaces/:route/capabilities/search`
- `POST /agent-api/v1/runs/:run_id/complete`
- 工具执行继续使用 `POST /agent-api/v1/tool-invocations` 与既有 resume 端点。

`turns` 与 `complete` 的原始 JSON 请求上限为 512 KiB。该上限可覆盖 64000 字符 Unicode 文本的 JSON 编码、Turn 的 16 KiB `page_context` 以及合理 envelope；解析后仍按各字段的字符上限严格校验。

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
  "capabilities": { "revision": "<sha256>", "authorized_total": 312, "active_limit": 8, "readonly": 311, "writes": 1, "approval_required": 1 }
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

## Complete

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
