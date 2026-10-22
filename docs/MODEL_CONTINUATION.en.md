# Long-task continuation and original-request recovery

[简体中文](MODEL_CONTINUATION.md)

Each model generation has an output budget. A host Agent task can span many model calls and tool actions. Appropriate budgets and controlled continuation complement each other; removing bounds or repeating the whole task is not a truncation strategy. This guide uses existing `bailing.model-operation.v1`, `bailing.model-stream.v1` and `bailing.provider-response.v1`, without a new continuation endpoint or private finish field.

## Hub and host responsibilities

Core dispatches one configured request, forwards native provider JSON/SSE and saves its response, usage and dispatch evidence under the original `operation_id`. `orchestration=host` leaves task loops, semantic parsing, tool execution, checkpoints and presentation with the client host. Core never automatically repeats a POST because of `length`, missing text, an HTTP error or an unknown provider finish reason, and never switches model, protocol or credentials as a retry.

`result_state=complete` means the provider exchange was saved. Answer completeness, tool-call completeness and overall task completion are separate host decisions. `billing_state=pending` does not block use of a saved result. Timeout, input bytes, context window, service ceiling and allowance remain independent bounds that continuation cannot bypass.

## Two distinct paths

| Confirmed condition | Host action |
| --- | --- |
| Original terminal operation is available and the provider adapter explicitly recognizes budget cutoff | Save partial content/checkpoint; prepare a distinct next-segment operation within task authority |
| Lost POST ACK, missing final operation frame, uncertain transport or storage result | Inspect the original operation first; recover saved evidence, never generate under another ID |
| Original operation remains pending | Wait or inspect that ID without parallel replacement generation |
| Normal stop, content filtering, rejection or unknown finish reason | Follow native adapter semantics without guessing automatic continuation is allowed |
| Cancelled task, ended authority or expired response without a trusted local copy | Stop automatic continuation, keep evidence and present the reason/action |

Only an adapter-supported explicit output-budget finish reason can enter the cutoff path, such as supported `finish_reason=length`. Unknown extensions are not interpreted by string guesses. Token counts equal to the budget, a short answer, normal HTTP EOF, settled billing or SSE `[DONE]` alone neither establish task completion nor permit a new segment. Some routes share output between reasoning and answer; follow the [output-budget contract](MODEL_OUTPUT_BUDGET.en.md).

Both original lookup and a repeated identical POST are protected by existing idempotency, but recovery should use read-only lookup. Changed content under the same ID conflicts; changing parameters, context or model cannot rewrite a saved intent. A lookup miss is not permission inferred from supposed non-execution; retain and resolve recovery gaps.

## Host checkpoints

Before another segment, persist the task, original operation, selected service/descriptor revision, normalized finish reason, delivered partial content, tool results and completed/remaining steps. The next segment uses a new operation, with a parent link in host-local storage; this protocol adds no parent-operation field.

Carry saved valid content and tool results forward and continue unfinished work. Do not present the original user request as a brand-new unexecuted task or resend its model call. Native tool-call/result formatting and association IDs must remain valid. The host can merge display fragments or repeated prefixes without changing raw response or tool-result evidence.

Automatic continuation needs bounded consecutive segments, cumulative task time/cost or Token budget, loop/no-progress detection and user cancellation. The host chooses defaults under its existing task policy, never unbounded recursion. At a boundary, retain the checkpoint and show a concise reason/action rather than repeatedly asking the user to type “continue.” Near the context window, use the host's existing recoverable summary mechanism and preserve action/result references, deduplication and approval evidence.

Restart, offline recovery and replayed streams must resume the same checkpoint rather than racing two continuations. A cutoff fragment without the final operation receipt first requires original-operation recovery. Late results after user cancellation or task completion never restart the loop.

## Text continuation must not repeat business effects

Model-operation idempotency only protects that model request. It cannot identify the same business intent proposed with a new invocation in a later segment. Persist the relationship between business action, original `invocation_id`, input digest, approval and result. A new `tool_call_id` or identical arguments alone neither proves a new write was authorized nor justifies blanket deduplication across separate tasks.

Do not execute tool calls from a truncated response even when a partial argument string happens to parse as JSON. Wait for adapter-confirmed complete tool-call termination, then apply the original schema, authority, approval and idempotency checks. Automatically repaired arguments are not the original invocation.

- Reuse completed invocation receipts/results; do not create a replacement action.
- Inspect uncertain or `reconciliation_required` calls before any further decision; continuation is not permission to retry a write.
- Agent SDK `inspectInvocation()` reads the original receipt without consuming approval or dispatching.
- Agent SDK `resume()` may perform the original invocation's first dispatch after approval. It is not polling/read-only inspection and is used only when original state and task authority permit that continuation.

Business-side idempotency and final authority remain necessary. Core does not promise exactly-once side effects across arbitrary external systems.

## Verification limits

`provider-stream.test.ts` checks JSON/SSE cutoff, Chinese/multibyte text, reasoning usage and unfinished arguments without altering their bytes. `model-continuation.test.ts` runs actual gateway logic with synthetic persistence/pricing ports to check complete exchanges, original-ID recovery, conflict rejection, distinct continuation and transport uncertainty without retry. Those ports are not database-transaction, real-provider, client-persistence or business-effect acceptance.

Client products must separately verify segment bounds, no-progress exit, cancellation, crash/restart, concurrent windows, context summaries, completed-tool reuse and uncertain-write reconciliation. Deploying Core alone does not implement that client loop.
