# Paired upgrade guide for 0.8.0: longer tasks and attachment delivery

Upgrade Core 0.7.0 / SDK 0.5.0 / DSH 0.5.0 to Core 0.8.0 / SDK 0.6.0 / DSH 0.6.0 using the deployment-specific release procedure. Preserve original configuration and persistent records.

## Choose the required features

| Need | Core | SDK / DSH and host | Business backend |
| --- | --- | --- | --- |
| Configure Hub tool limits | New Core, migration 061 and policies | Paired packages for retry guidance and original-call recovery | Keep APIs/declarations; backend limits remain independent |
| Use generated or explicitly selected images | New Core, 060, storage and workspace switch | New SDK, controlled source and durable upload store in the DSH host | Existing URL APIs work; asset IDs/imports remain business operations |
| Switch tools within a turn | Paired Core for full discovery feedback | New DSH merges valid tools | No new requirement |
| Reuse declarations across messages | Current-turn preparation and permission checks remain | Opt into `toolLifecycle: 'session'` and handle preparation | No new requirement |
| Inspect/recover after reopening | New read-only receipt API | New SDK/DSH, durable invocation store and panel methods | Original invocation and approval rules remain |
| Task budgets, concurrency and pause | New Core, 062 and administrator-created tasks | Paired packages, task store and complete original-scope verification | Counts invocations, not products or monetary impact |

Other MCP hosts and adapters do not gain these integrations automatically. Ordinary unenrolled authorizations retain their existing flow. Unsupported interfaces must not cause fallback to a broader or default authorization.

## 1. Preserve original state

Back up the database, configuration, encryption material, storage settings and objects. Original argument snapshots use a key derived from the instance's `server.token`. Do not combine a normal upgrade with an unplanned rotation: an old snapshot that cannot be decrypted must block recovery rather than be reconstructed.

Hosts retain secure credentials, connection instance keys, real Sessions, fixed scopes, events, archive outbox/ACK/CAS, upload and invocation journals, and task bindings. Protect these private stores; do not commit or publish them. An upgrade should not recreate authorizations or conversations.

## 2. Upgrade Core and apply migrations

Use final released artifacts and the deployment-specific upgrade procedure. Check the intended database, then run the official migration runner (`npm run db:init` for a source installation) for all unapplied files before starting the new service. Startup does not migrate implicitly.

| New since Core 0.7.0 | Purpose |
| --- | --- |
| `060_agent_artifacts.sql` | Original image-upload receipts; binary objects stay in operator storage |
| `061_tool_rate_limit_policies.sql` | Provider defaults and per-tool overrides; existing null settings inherit declarations |
| `062_agent_task_control.sql` | Six tables for task bindings, enforcement, invocations and budgets/permits |

Verify the migration ledger and readiness. Do not manually replay applied SQL. Older baselines also need their missing earlier migrations. Existing candidate deployments must compare migration records and checksums rather than recreate tables.

Persistent task control needs the corresponding MySQL repository. Embedded hosts lacking optional support report unsupported. A configured managed flow must block on missing tables or database failure, not fall back to unrestricted dispatch.

## 3. Upgrade the actual SDK, DSH and host

The released DSH must depend on the exact paired SDK, with a matching lockfile. Editing the source manifest alone does not upgrade a desktop Profile or packaged application. Verify actual consumer resolution and nested copies. An earlier same-numbered candidate is identified by hash; it is not the public 0.5.0 package.

- Cross-turn reuse: enable `toolLifecycle: 'session'`, preserve the real Session/runtime and handle preparation with current schemas. `active_turn` remains the default. Restart empties the declaration cache; the separate invocation journal can still recover original operations.
- Recovery and panels: persist `invocationStore`; use `inspectSessionInvocation` / `resumeSessionInvocation` with the original real Session, ID and cancellation signal. Reads never invoke resume. Null results stay unconfirmed; storage errors and history gaps cannot display stale success.
- Tasks: persist `taskStore`, obtain original coordinates with `getSessionTaskCoordinates` and bind the administrator-created task. Restore original scope/task/journal. The model does not choose task IDs.
- Images: connect a controlled `artifactSource` and durable `artifactStore`. Register only files approved for business use in the current conversation. Ordinary chat attachments are not synchronized automatically. The model chooses neither buckets nor arbitrary local paths.

Do not reconstruct missing historical bindings or arguments from text. Old SDK/Core versions without read-only receipts report unsupported; inspection must not fall back to resume.

## 4. Enable features with a small validation scope

Configure Media Storage, then select it under Agent Clients → Connection Configuration → Tools and Approval → Generated Image Upload. Objects are public in the first phase; use an image suitable for public display.

Configure provider-wide, default per-tool and individual override limits under Tool Providers → Edit → Governance. A provider gate value of `0` disables only that layer. Client-app, per-tool and backend gates remain independent. The same provider/tool shares its counter across conversations.

Create and bind a task using dedicated test authorizations. **Enrollment persists a requirement on each original Agent Session, including its other conversations and older entry points. Cancellation does not remove the marker.** Check all relevant hosts before enrolling ordinary authorizations. A task write budget of `0` means read-only; `null` means no cumulative write cap.

## Observable checks

1. Ordinary chat does not create business runs just to restore tools or inspect a panel. Unselected targets receive no requests.
2. Query a shop product, inspect inventory and return to the product: targets remain correct; valid tools are reused or prepared with complete schemas.
3. Upload a public test image, obtain a ready URL and recover the same upload. The business action using that URL has its own result or approval.
4. In a synthetic task, counts survive turn changes; pause stops new dispatch permits while original outcomes remain readable.
5. Reopen a conversation with trustworthy persisted invocations: inspect sends no business action; explicit continuation retains the original ID. Unknown writes are not replaced. Cancelling a wait is not displayed as withdrawing a business request.

Synthetic and automated checks do not replace each deployer's actual client acceptance. Focus on the enabled features and final artifacts rather than repeating unrelated tests.

## Rollback and limits

Before task enrollment, assess rollback against new persistent records and interfaces and retain migration tables/ledger. **Once enforcement markers exist, do not revert to a Core/host that ignores them or delete markers to remove control.** Pause managed dispatch and inspect in-flight calls first; prefer a forward fix. Restoring a backup requires separately reconciling business effects since that backup. Database restoration is not business rollback.

Task quotas exclude host-local tools, model inference, attachment uploads and chat archives. They do not measure product count, money or field impact. Cross-Hub tasks, full-plan automatic restart and compensation are not provided. Some host attachment-source listing errors can still surface as `unknown_failure`; they must not be displayed as an empty list. Per-item upload errors and already-ready URLs remain separate.
