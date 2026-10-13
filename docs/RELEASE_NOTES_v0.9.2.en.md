# v0.9.2: secure installation and persisted continuation

[简体中文](RELEASE_NOTES_v0.9.2.md)

Version date: 2026-10-13. A patch update from public Core 0.9.1.

A model result has returned, but settlement remains pending. An approval is recorded, but a temporary failure leaves the original job outside the queue. BailingHub 0.9.2 continues checking and recovering these persisted records without waiting for another request, and fixes credential generation when secure randomness fails during installation.

## Fixes

### Stop installation when secure randomness fails

When creating configuration, the installer generates its six default credentials independently through secure randomness. Missing OpenSSL, a failed producer or invalid output stops installation before writing a partial `.env` or starting services. Existing `.env` files are preserved, including changed administrator passwords. Operators need a working OpenSSL implementation; timestamps and digests are not randomness substitutes.

### Advance asynchronous settlement without traffic

Reconciliation previously depended on requests. standalone now schedules an initial pass and subsequent passes every minute; managed Kernels use their first and subsequent existing `tick()` calls. Pages contain at most 50 records, advance by cursor and wrap at the end. Unpriceable or individually corrupt records no longer repeatedly occupy the first page and block later records.

Reconciliation uses the original request's saved metering, reference prices and unified multiplier. It does not read generated bodies, contact providers or redispatch models. Missing authoritative metering remains pending/unknown, rather than becoming an invented zero charge. Work for one owner shares an active pass, with database-failure backoff. Shutdown stops new maintenance and waits for started evidence writes; a timeout retains work for same-instance retry.

### Persist continuation for the original approval decision

External callbacks and the console save the decision and continuation record in one transaction. Retrying the original `decision_id` can recover temporary auditing or queue failures; background maintenance also advances unfinished continuations. A saved decision whose continuation fails returns `503` and `decision_recorded=true / continuation_pending=true`. Do not create another approval for recovery.

Original-job queue admission and the decision marker are written atomically, with consumed-approval checks repeated inside the admission critical section. Lost queue acknowledgements, process reopening and completed subsequent runs cannot admit the job again for the same decision. Consumed approvals are not requeued; historical decisions without new continuation records are not backfilled. Denials only complete auditing. Direct Agent invocations still require the original Agent to explicitly resume the original `invocation_id`; approval does not start a Core model loop.

## Additional diagnostics and public regressions

`npm run doctor -- --deployment --url <Core URL>` adds read-only deployment diagnostics. By default it checks `/health`, `/version` and local artifact identity. Only explicit `--readiness` asks the server to check its database and migration ledger. Diagnostics perform no upgrade, rollback or migration. Matching declarations do not establish artifact integrity, actual database identity or deployment acceptance; see [scope and exit codes](DEPLOYMENT_DIAGNOSTICS.en.md).

This release also ships actual child-process `SIGKILL` and lost MySQL COMMIT-acknowledgement model recovery regressions for the first time. They validate existing original-request recovery and settlement semantics, adding test coverage rather than automatic redispatch behavior. Approval acceptance also covers recovery in another PID, lost acknowledgements and concurrent continuation. See [model process recovery regressions](MODEL_PROCESS_RECOVERY.en.md) and [Core reliability regressions](CORE_RELIABILITY.en.md).

## Who should upgrade

- **Core operators** using the installer, model billing or external/console approvals should upgrade and apply 065/066. Preserve configuration, databases, original requests and rollback artifacts first.
- **Embedded and custom-adapter developers** retain fair `tick()` calls and `close(drainMs)`, and supply matching continuation ledger methods plus `RuntimeStateStore.requeueApprovedJobOnce`. New decisions are explicitly unavailable without these implementations; they do not fall back to the old unrecoverable queue path.
- **Business-backend and client integrators** retain existing declarations, signature verification and final authorization. Approval retries retain the original decision identifier; result recovery retains the original invocation identifier. MCP / Agent Client SDK 0.7.0 and DSH 0.7.0 remain unchanged. ACC, independent Hosts and clients release separately and are not part of this Core patch.

## Upgrade and verify

Relative to 0.9.1, this release adds `065_usage_reconciliation_scan.sql` and `066_approval_continuations.sql`. Apply all outstanding files through `npm run db:init` or the official explicit Kernel migration port. Runtime startup does not migrate automatically. Coordinate old writers and verify migration plus adapter support before starting the new version. The [upgrade guide](UPGRADE_v0.9.2.en.md) covers preserved data, original-ID checks, diagnostics and rollback.

After verifying artifact identity, migration ledger and health, check settlement without traffic, approval failure recovery and close draining in a dedicated test environment. Public regressions use isolated databases and synthetic providers; they do not establish live-provider or production business acceptance. Queue admission deduplication does not guarantee exactly-once external business effects.

[Upgrade guide](UPGRADE_v0.9.2.en.md) · [Full changelog](CHANGELOG.en.md) · [Capability and evidence index](IMPLEMENTATION_STATUS.en.md) · [Previous release](RELEASE_NOTES_v0.9.1.en.md)
