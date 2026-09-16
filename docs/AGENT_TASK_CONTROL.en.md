# Task budgets and pause control

Use Core 0.8.0 with Agent Client SDK / DSH 0.6.0 and an adapted host. Task controls require explicit administrator enrollment. See the [complete protocol and operator guide](AGENT_TASK_CONTROL.md).

An assistant updating shop products and checking stock may work across several messages and systems. An administrator can freeze the original authorizations, exact tool names, cumulative write-call allowance, concurrency and optional expiry for that task. New messages, tool searches and client restarts do not reset the allowance. Existing business APIs, ACC declarations, authorization and approval rules remain unchanged.

Use **Agent Clients → Task control** to create and inspect tasks. The host verifies every original member and persists the binding before business execution. Agent access tokens cannot create tasks, increase budgets or control their state. Participating Agent Sessions become persistently task-required across conversations; cancelling a task does not remove that requirement. Use dedicated synthetic authorizations when first integrating.

- A write call is a call whose trusted declaration has `readonly=false`, including idempotent writes. It is not a product, monetary amount, token or successful business change. `null` means unlimited; zero allows reads only.
- Metering covers governed business tool invocations through the Hub, not local host tools, inference, artifact uploads or conversation archives.
- Approval waits reserve writes. Confirmed HTTP outcomes consume them, including business rejection. Unknown outcomes retain their reservation and concurrency permit.
- Pause blocks new permits, while already permitted requests can finish. Continue keeps the original scope and limits and does not execute anything automatically. Cancel cannot be undone and does not roll back business changes.
- Approval consumption, permit, original-job fence and execution journal commit atomically before HTTP dispatch. Unknown results are inspected using the original invocation; do not submit a replacement write.

Agent endpoints are `GET /agent-api/v1/task-control/capabilities` and `GET /agent-api/v1/tasks/{task_id}?workspace=...&client_conversation_id=...`. Turn creation accepts and echoes trusted `task_binding` (`bailing.agent-task-binding.v1`, `task_id`, `scope_hash`). Task snapshots use `bailing.agent-task.v1`, disclose only the requesting member and shared counters, and explicitly do not confer dispatch permission. Verify the complete original group; this release supports one Hub and audit domain only.

Read-only progress uses `GET /agent-api/v1/tool-invocations/{invocation_id}/receipt`. `POST .../resume` can dispatch an approved original operation and must never be used as a polling method. Managed runtime searches require the bound `run_id`; discovery itself does not consume the write allowance.

The administrator APIs are `GET/POST /admin/api/agent-tasks`, `GET /admin/api/agent-tasks/{task_id}`, and `POST /admin/api/agent-tasks/{task_id}/control`. They require `clients:read` or `clients:write`. Create freezes `members` and `policy`; controls require a stable request ID, expected revision and `pause/resume/cancel`. Read the complete guide for exact wire fields and pagination.

The paired SDK adds `getTaskControlCapabilities`, `getTask`, and trusted `startTurn` task binding. DSH supplies host CAS storage and task restoration, lazy business runs, read-only polling and original-invocation recovery. Business backends need no new endpoints.

This integrates the existing six-table migration `062`; it adds no further migration. Fully unmigrated installations report unsupported. Partial tables or database failures fail closed. Old clients can continue using non-enrolled Sessions, but cannot bypass an enrolled Session's requirement. After enrollment, do not roll back to a Core that cannot enforce the marker or remove task tables to disable enforcement.

`TASK_DISPATCH_UNCERTAIN`, or `TASK_UNAVAILABLE` during invoke/resume, conservatively requires original-call inspection. Revocation of any original member blocks the group; neither default targets nor a remaining subset are valid fallbacks. Local synthetic acceptance does not imply deployment or production acceptance.
