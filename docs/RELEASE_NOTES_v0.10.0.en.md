# Core v0.10.0: Discover capabilities, then read the knowledge you need

[简体中文](RELEASE_NOTES_v0.10.0.md)

A local agent checking inventory should not always receive several unrelated documents. A larger page design should not hit a small argument limit before dispatch. Relative to public 0.9.4, Core 0.10.0 adds on-demand knowledge and tool guidance, aligns bounded argument capacity, and improves model-budget configuration, onboarding and diagnostics.

The component set is **Core 0.10.0, MCP / Agent Client SDK 0.8.0 and DSH 0.8.0**. These are independent releases. Existing tool clients and bundled chat remain usable; update the corresponding consumer when adopting new host features or fixing its independent argument limit. No new SQL is added relative to 0.9.4, and this is not a 1.0 stability declaration.

## What changes

### Agents can read hints before requesting documents

New Agent Session knowledge `capabilities / search / read` endpoints support explicit negotiation. A host that selects `knowledge_delivery: "on_demand"` receives bounded hints and reads authorized, revision-bound references only when needed. Search and pagination have byte/count/expiry limits. Expired references or changed authority require rediscovery; knowledge never bypasses subject, route or approval boundaries.

Clients that omit the option retain inline knowledge. **Bundled chat, embed and widget retain server-side retrieval and full context assembly.** Knowledge and execution summaries are reference material, not permission grants or a complete user-level long-term memory system.

### Short descriptions no longer silently discard longer guidance

Discovery keeps short descriptions and identifies available guidance and actual truncation separately. Named guidance reads recheck current authority and capability revision. Standard summary, description, ACC guidance and the first example are retained within bounds. Discovery distinguishes authorized candidates, returned results and an unknown exact match total; a full result list is not proof of exact relevance.

Discovery revisions remain separate from frozen execution fingerprints. Guidance-only changes do not require repeating an approved business operation; original invocations retain their identity and arguments.

### Larger arguments stay intact and limits identify their boundary

Tool arguments are measured as the UTF-8 bytes of actual `JSON.stringify(arguments)`, with a **1 MiB** maximum and **2 MiB** tool-call HTTP envelopes. Core and the independent MCP/SDK limits align. Objects stay objects. Capability schemas, signatures, authority, approvals, idempotency and the business system's own limits remain effective.

Oversize replies retain `arguments_too_large`, `not_dispatched` and safe actual/allowed or observed byte counts, never the body. Full approval arguments remain linked to their digest; notifications contain bounded previews and the console cannot approve before loading the complete arguments. Updating Core alone does not change an older client's own smaller limit.

### Default output budgets and service ceilings are separate

An optional explicit policy declares a default budget, service ceiling, actual output parameter and `completion_total / final_answer` scope. Operators verify the real model route; Core neither guesses from model names nor enlarges every budget. Existing services keep their configuration and behavior. Image tools do not use chat output budgets.

The wrong parameter produces a clear pre-dispatch rejection rather than silently renaming `max_tokens` to `max_completion_tokens`. Original operations and digests stay intact. A model-output cutoff is distinct from transport uncertainty; the host decides any next segment within task authority. **Core neither retries the model automatically nor implements a client's long-task continuation loop.**

### Setup and troubleshooting retain context

Onboarding, invocation examples and permission wording are clearer. Routes, clients and tool sources protect unsaved forms. Approval continuation differs from a new task rerun; diagnostic navigation preserves filters, tabs and return positions. Late responses cannot overwrite the current object. Drawer help is placed behind question marks while risks and errors remain visible, and login-password autofill is blocked in configuration forms.

The read-only `doctor --upgrade-plan` compares explicitly supplied artifacts and redacted migration snapshots without connecting to a database or applying migrations. Kernel boot recovery participates in shutdown drain. Readiness checks actual state/configuration resources and full migration digests. Custom MySQL stores must expose `schemaReadinessDb` or fail closed; see the upgrade guide.

## Who needs to change

| User | Impact |
| --- | --- |
| Hub operators | Upgrade the complete artifact, back up and drain, and verify actual storage readiness. Explicit model policies are opt-in; existing budgets do not change automatically. |
| Business backends | Existing HTTP/HMAC/ACC identity and authority remain intact. No endpoint rewrite is required. Keep business field, body and storage limits. |
| MCP/SDK and DSH host developers | Adopt 0.8.0 for larger arguments, on-demand knowledge, budget helpers and disclosure confirmation. Never rewrite saved requests. Hosts still own final model serialization, executable tool registration and task loops. |
| Kernel Host developers | Default stores support actual-resource readiness. Custom MySQL stores expose their real read-only resource. Independent Host pins, artifacts and deployments need their own checks. |

## Upgrade and verify

Follow the [0.10.0 upgrade guide](UPGRADE_v0.10.0.en.md) to preserve configuration, data, original calls and rollback material. There is no new SQL from 0.9.4; earlier versions still need outstanding migrations on their original upgrade path.

Verify exact Tag/commit, package identity and migration ledger, then check `/health/ready`, onboarding, save/cancel behavior, original approvals and read-only receipts. Test larger arguments and new knowledge behavior with isolated data. Basic acceptance needs no paid model call or modification of a real business page.

Public regressions cover synthetic providers, authority/revision changes, byte bounds, original-operation recovery, persistence and lifecycle. They do not establish acceptance of every provider, desktop product or external business side effect. Knowledge may be paginated or truncated; timeout, context, input-size, vendor hard limits and account allowance remain bounded. Synthetic tests do not replace non-author integration or long-term observation.

[Knowledge protocol](AGENT_KNOWLEDGE_API.en.md) · [Runtime API](AGENT_CLIENT_RUNTIME_API.en.md) · [Model budgets](MODEL_OUTPUT_BUDGET.en.md) · [Host continuation and recovery](MODEL_CONTINUATION.en.md) · [Changelog](CHANGELOG.en.md)
