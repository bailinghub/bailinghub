# Agent Client Runtime v1

English | [简体中文](AGENT_CLIENT_RUNTIME_API.md)

This versioned API lets a browser-authorized local Agent plan locally while reusing BailingHub
identity revalidation, tool governance, approvals, audit, and the visible conversation ledger. It
does not replace `/run`, chat entries, or the executor protocol. See the
[Agent Client Integration Guide](AGENT_CLIENT_QUICKSTART.en.md) and
[Agent Auth v1](AGENT_AUTH_API.en.md) for deployment and authorization.

Every endpoint requires `Authorization: Bearer <Agent access token>` and returns
`Cache-Control: no-store`. The workspace is the intersection of the Client `allowed_routes`, Agent
Session `allowed_routes`, enabled and audience-compatible routes, and `tools.agent_direct`.
`agent_client.enabled=false` disables this Runtime only; it does not disable the older
`/agent-api/v1/tools` surface.

## Endpoints

- `GET /agent-api/v1/workspaces`
- `GET /agent-api/v1/workspaces/:route/bootstrap`
- `POST /agent-api/v1/workspaces/:route/turns`
- `POST /agent-api/v1/workspaces/:route/capabilities/search`
- `POST /agent-api/v1/runs/:run_id/complete`
- Tool execution continues to use `POST /agent-api/v1/tool-invocations` and the existing resume
  endpoint.

Raw JSON for `turns` and `complete` is limited to 512 KiB. Parsed values still have strict field
limits; the service rejects invalid input instead of truncating it silently.

## Write and approval semantics

`tools.agent_direct.write_tools` exposes exact write operation IDs to the local Agent. Approval
requirements continue to come from the business ACC `risk`, `approval.required`, and
`approval.when` declarations. A route may add stricter approval by listing an exact operation ID
under `tools.agent_direct.force_approval_tools`; it cannot weaken ACC policy.

The deprecated private-candidate field `unattended_write_tools` remains readable for migration.
Do not configure it together with `force_approval_tools`. When converting old configuration, put
the difference between the old `write_tools` and `unattended_write_tools` sets into
`force_approval_tools`, rather than copying the old list unchanged.

## Bootstrap

```json
{
  "schema_version": "bailing.agent-runtime-profile.v1",
  "workspace": {
    "route": "order-assistant",
    "name": "Order assistant",
    "description": ""
  },
  "profile": {
    "revision": "<sha256>",
    "instructions": "...",
    "memory": {
      "recent_messages": 12,
      "recent_budget_chars": 8000,
      "per_message_chars": 2000,
      "summary_enabled": false,
      "summary_max_chars": 1200
    },
    "knowledge": {
      "enabled": true,
      "sources": 1,
      "mode": "chunk",
      "top_k": 5,
      "max_docs": 4,
      "page_boost": false
    },
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
  "capabilities": {
    "revision": "<sha256>",
    "authorized_total": 312,
    "active_limit": 8,
    "readonly": 311,
    "writes": 1,
    "approval_required": 0
  }
}
```

Bootstrap extracts only `target_config.system_prompt` field by field and appends optional
`agent_client.instructions`. It never returns credentials, model configuration, other
`target_config`, Tool Provider base URLs/secrets, or business egress configuration.

## Turn

```json
{
  "client_conversation_id": "local-conversation-1",
  "client_turn_id": "turn-1",
  "user_message_id": "message-1",
  "user_input": "Find the employee named Ada",
  "page_context": { "url": "/staff", "title": "Staff" },
  "renderers": ["markdown", "bailing-form.v1"]
}
```

The four identifiers/input fields are required. `page_context` and `renderers` are optional and
unknown fields are rejected. `user_input` is limited to 64,000 characters; no more than 20 unique,
valid renderer names are accepted.

The response uses `bailing.agent-turn-context.v1` and contains a stable `run_id`, profile and
capability revisions, safe instructions, memory, reference-only knowledge, governance, and the
active typed tool set. The same Agent Session + route + conversation + turn, and the same
`user_message_id`, resolve to the same frozen run/context. A changed payload under the same key
returns `409`. Core reads prior memory before it appends the current visible user message.

Capability search returns no more than 12 complete typed tools under
`bailing.agent-capability-search.v1`, always within the authorized set. If semantic retrieval for
any source is unavailable, the whole search deterministically falls back to lexical ordering. A
search needs a non-empty query or a valid `run_id` from the same Agent Session and route.

## Tool invocation and recovery

Invoke only a tool projected by the current bootstrap/search result. Core revalidates the Agent
Session, route, operation ID, ACC declaration, approval state, limits, and business authorization
on every invocation. When the result is pending, in progress, or uncertain, resume the original
`invocation_id`; do not create a replacement write call.

The Hub records visible governance milestones, operation IDs, parameter key names, approval state,
and business status. It does not receive model hidden reasoning, complete sensitive arguments, or
raw business response bodies.

## Complete

```json
{
  "assistant_message_id": "assistant-message-1",
  "status": "completed",
  "content": "Done.",
  "model": "optional-model-name",
  "runtime": "optional-runtime-name",
  "usage": {
    "input_tokens": 120,
    "cached_input_tokens": 80,
    "output_tokens": 30,
    "total_tokens": 150,
    "tool_calls": 1
  }
}
```

The assistant message ID, status, visible content, model, runtime, and public usage form one
idempotency fingerprint. An identical replay returns `200`; any changed field returns `409`.
Hidden reasoning is neither accepted nor stored. Content is limited to 64,000 characters and
model/runtime to 191 characters each; invalid values are rejected rather than normalized silently.
