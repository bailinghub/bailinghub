# Core v0.9.2 patch upgrade guide

[简体中文](UPGRADE_v0.9.2.md)

Upgrade public Core 0.9.1 to 0.9.2 for installation secrets, asynchronous settlement maintenance and approval continuation fixes, plus read-only deployment diagnostics and process recovery regressions. MCP / Agent Client SDK and DSH remain at 0.7.0. This upgrade concerns Core; other components verify and release within their own projects.

## Preserve data and coordinate writers

Back up the target database. Preserve configuration and credentials, attachment storage, original requests and approvals, previous artifacts and host persistence. Stop new work and coordinate all writers sharing the state database. Check original in-flight requests and saved decisions before draining and closing instances. Retain original `operation_id`, `invocation_id` and approval `decision_id`; do not replace recovery with a new request.

The 0.9.1 usage shutdown drain remains effective. New 0.9.2 maintenance writes also participate in close draining. After a timeout, wait and retry on the same instance; do not force-close stores or redispatch requests.

## Select artifacts and migrate explicitly

Use formal `v0.9.2` source, npm packages or images. Verify version, source Tag/commit and artifact digest. Installer and prebuilt-image Compose defaults are updated to 0.9.2; existing `.env` files are preserved. Creating configuration requires working OpenSSL. Repair randomness failures before retrying installation.

Apply all outstanding files through the official migrator. For source installations:

```bash
npm run db:init
```

Embedded hosts use the explicit official `migrateBailingHubCoreSchema` port and recheck the complete `BAILINGHUB_CORE_ARTIFACT_V1` artifact manifest. Startup does not migrate automatically. The migrator skips recorded files; do not edit historical SQL or migration records manually.

| Migration added since 0.9.1 | Purpose |
| --- | --- |
| `065_usage_reconciliation_scan.sql` | Add the `(billing_state, updated_at, id)` paging index, without recalculating historical charges |
| `066_approval_continuations.sql` | Add the continuation table and `bz_jobs.approval_continuation_keys` for original-decision continuation and permanent admission markers, without backfilling historical decisions |

Apply 066 before enabling new approval paths. Failed continuation writes roll back the decision rather than leaving an orphaned decision. Earlier versions also apply all missing preceding migrations; see the [0.9.0 guide](UPGRADE_v0.9.0.en.md) for model billing upgrades.

## Match adapters and callers

Upgrade official MySQL/JSONL state adapters together with the configuration approval ledger. JSONL serial writes support only one writer; multiple processes must not write the same file. Custom configuration adapters implement `decideWithContinuation`, `getContinuation`, `pendingContinuations`, `markContinuationAuditRecorded` and `completeContinuation`. Custom state adapters implement `RuntimeStateStore.requeueApprovedJobOnce` with matching atomic semantics. Unsupported new decisions return `approval_continuations_unavailable`, without falling back to the old queue path.

External retries of the same decision retain its original `decision_id`. A `503` with `decision_recorded=true / continuation_pending=true` means the decision was saved and continuation awaits recovery. Console retries retain the original approval. Historical decisions without new continuation records are not backfilled; consumed approvals are not requeued. Direct Agent invocations still require the local Agent to explicitly resume the original `invocation_id`; approval does not start a Core model loop.

Managed hosts continue fair calls to existing `tick()`. The first tick and subsequent minute-based maintenance advance pending settlement and approval continuation; standalone schedules these passes itself. No separate timer per Kernel is needed. Existing contracts continue to control pause, routing, tool permissions and final business authorization.

## Verify the upgrade

1. Check artifact identity, the target database's migration ledger and actual 065/066 structures. Verify `/health`, the console and existing business smoke checks.
2. Use read-only deployment diagnostics for public identity and readiness. Read the exit code together with the unchecked scope:

   ```bash
   npm run --silent doctor -- --deployment --url http://127.0.0.1:18900 --readiness --json
   ```

   Default diagnostics only read health and version. `--readiness` asks the server to read its database and migration ledger. Diagnostics do not establish image digest or complete database identity, or perform upgrades; see [diagnostics](DEPLOYMENT_DIAGNOSTICS.en.md).
3. In a dedicated test environment, retain a meterable original pending request and stop incoming traffic. Verify settlement in its original ledger without another provider dispatch. Records lacking authoritative pricing or metering remain pending/unknown. Check the shared USD allowance and multiplier; result complete does not mean billing settled.
4. In a dedicated test environment, check a temporary audit or queue failure after approval. Retrying the original decision or waiting for maintenance should continue the original job. Lost queue acknowledgements, reopening or consumed approvals must not duplicate admission. Direct Agent calls still wait for explicit resume. Lost audit acknowledgements may produce repeated observations with the same `detail.continuation_id`, rather than another queue admission.
5. Confirm maintenance drains during shutdown. A timeout retains same-instance work and dependencies for later retry. Do not delete ledgers, clear markers or replace invocation IDs.

See [Core reliability](CORE_RELIABILITY.en.md#regression-entry-points-and-limits) for isolated regression commands and [model process recovery](MODEL_PROCESS_RECOVERY.en.md) for actual `SIGKILL` and lost COMMIT-acknowledgement acceptance. These tests use dedicated databases and synthetic providers. Skips are not passes, and regressions do not replace target-deployment or live-business acceptance.

## Rollback boundary

065/066 are additive migrations. A code rollback retains continuation tables, `approval_continuation_keys`, original requests and ledgers. Do not delete markers and resubmit approvals. Returning to 0.9.1 loses this release's automatic maintenance, persisted continuation and admission deduplication guarantees. Stop decision and job writes, then reconcile saved decisions, queue state, markers and in-flight work before assessing compatibility and rollback.

Restoring an older backup also requires accounting for requests, charges and external effects after that backup. Queue deduplication does not guarantee exactly-once external effects, and restoring a backup does not undo business actions. Business services retain idempotency and final authorization.

[Release notes](RELEASE_NOTES_v0.9.2.en.md) · [Reliability contract](CORE_RELIABILITY.en.md) · [Compatibility policy](COMPATIBILITY.en.md)
