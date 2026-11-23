# Core v0.11.0 · Cross-channel task tracing and model context windows

[简体中文](RELEASE_NOTES_v0.11.0.md)

## Trace an assistant reply back to its task

When a user reports that the assistant replied but an order still shows its old status, open **Tasks → Conversations** and find the conversation by source and recent activity. The list distinguishes clients, the web assistant, WeCom and channel deliveries. The detail view identifies user and assistant messages and opens at the latest message. Where the records exist, inspect the original authorization in the sidebar and follow the link to the execution trace. Each channel shows the content it has recorded. Some older records contain only a conversation header.

Filter dispatches by status, creation time and exact route to find older failures. When a trace search returns multiple matches, open one and return to the same list. Focus a status label with the keyboard to inspect its raw value. Unrecognized statuses display their original value. Task creation forms offer field guidance through the help icons. [Conversation audit](AGENT_CONVERSATION_AUDIT.en.md)

## Budget for the next model request

Under **Users and Usage → Model services**, select the credential and invocation model. The console looks up the **combined input and output window** for that route. When a precise provider limit is available, it fills in the value and allows a smaller service limit. Changing the credential or invocation model triggers a fresh lookup. A consistent existing registration on the same route may appear as a suggestion. If the limit is unknown, save a new service as inactive while you verify it. [Output budgets](MODEL_OUTPUT_BUDGET.en.md)

Hosts can use the existing `GET /usage/v1/model/models` endpoint to read `context_window_tokens` for the selected `service_id`. Allow for system instructions, message history, tools and the requested output within that window. A `null` window means the service has no registered limit.

For a recognized TokenHub input-length rejection, the final receipt can include `operation.response.diagnostic.code = CONTEXT_WINDOW_EXCEEDED`. If the original operation's service configuration recorded a window, the diagnostic can include that revision's limit. The host can use this information to compact the conversation and persist a checkpoint. On a generic HTTP 400, a connection loss or a missing final receipt, inspect the original operation before attempting further work. [Model continuation and recovery](MODEL_CONTINUATION.en.md)

Upgrading from v0.10.1 requires no new SQL migration. See the [upgrade guide](UPGRADE_v0.11.0.en.md) for deployment and read-only checks.
