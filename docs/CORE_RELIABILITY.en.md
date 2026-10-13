# Installation secrets, settlement maintenance and approval continuation

[简体中文](CORE_RELIABILITY.md)

This page describes fixes in the current source, pending a formal release. The published v0.9.1 tag, npm package and installation images do not contain these later changes. Verify each deployment's source identity and migration ledger separately.

## Installation secrets

When creating `.env`, the installer calls `openssl rand -base64 24` independently for six credentials. Each producer must exit successfully and return exactly 32 valid Base64 characters. Missing secure randomness, execution failure or invalid output stops installation before a partial `.env` is written or services start. Timestamps and digests are not substitutes for randomness.

An existing `.env` is preserved, including an operator's changed administrator password. Failed producers' output is not echoed. Install a working OpenSSL implementation before retrying.

Run `npm run installer:secrets:test` to check generation, failed producers, malformed output, late failures and configuration preservation. Tests use synthetic commands and temporary directories, without installing a real service.

## Automatic asynchronous settlement

standalone schedules an initial maintenance pass after startup and subsequent passes every minute. A new managed Kernel schedules its first pass on its existing `tick`, with subsequent passes driven by the same tick. Its Host must still call tick; no per-Kernel timers are introduced. HTTP uses the same maintenance port as a fallback, so saved usage recovery no longer depends on incoming traffic.

Maintenance reads saved metering, reference prices and the original unified multiplier. It does not read generated result bodies, contact providers or dispatch another model request. Pages contain at most 50 records, advance by `(updated_at, id)` and wrap at the end. Unpriceable or individually corrupt rows do not keep later records behind a fixed first page. Missing authoritative metering remains pending/unknown, rather than becoming an invented zero charge.

One usage owner shares an active maintenance pass; different owners remain independent. Database failures back off from one minute to a maximum of five minutes, resetting after success. `getReconciliationProgress()` exposes only the latest page's scanned, settled, deferred, failed and hasMore values. It is not a database-wide pending count and contains no result bodies, identifiers or credentials.

Maintenance participates in the existing background-work registry and Kernel close drain. standalone stops new maintenance before draining started evidence writes. A timeout retains unfinished work on the same instance for retry; it is not permission to close its stores.

## Approval decisions and continuation

External callbacks and the console save the decision and immutable continuation coordinates in one transaction. They bind the original approval, job, request, argument hash and decision identifier. Retrying the original `decision_id` can complete failed auditing or queue admission; background maintenance pages through unfinished continuations by approval identifier and wraps at the end, so in-flight or faulty records do not block later approvals. A saved decision whose continuation fails returns `503` with `decision_recorded=true / continuation_pending=true`. Do not create another approval to recover it.

The state adapter atomically writes original-job queue admission and a separate decision marker, rechecking whether the approval was consumed inside the admission critical section. If the queue write succeeds but its acknowledgement is lost, retries, process reopening and a completed new run cannot admit the job again for that decision. Ordinary job updates cannot remove the marker. An original job still in flight waits for later maintenance. Execution retains existing pause, route and tool governance.

Denied decisions only complete auditing. Direct Agent invocations remain manual: approval does not launch a Core model loop, and the original local Agent still explicitly resumes the original `invocation_id`. Consumed approvals and historical decisions without new continuation records are not automatically backfilled or requeued.

Losing an acknowledgement after a successful audit append may produce another observation with the same `detail.continuation_id`. Queue admission deduplication does not guarantee exactly-once business effects across systems; business services retain their own idempotency and final authorization. JSONL serial writes support one writer, not multiple processes writing the same file.

## Migrations and adapter boundaries

- `065_usage_reconciliation_scan.sql` adds the pending-settlement paging index, without recalculating historical charges.
- `066_approval_continuations.sql` adds the continuation table and `bz_jobs.approval_continuation_keys`, without changing old decisions or customer business data.

Use `npm run db:init` or the official explicit Kernel migration port. Runtime startup does not migrate automatically. Apply 066 before using new approval decision paths. A failed continuation insert rolls the decision back rather than leaving an orphaned decision. Coordinate old writers, retain backups and verify migration plus matching state/config adapters before enabling the new paths.

Custom adapters must implement the optional continuation ledger methods together with `RuntimeStateStore.requeueApprovedJobOnce`. New decisions are explicitly unavailable without them; there is no fallback to the old unrecoverable queue path. These are Core interfaces. Independent Host platform identities and tenant upgrade orchestration, and client model loops and long-term memory remain separate projects.

These migrations are additive. A code rollback must not delete continuation records or markers. Older code does not provide the guarantees on this page. Coordinate stopping decision and job writes, then reconcile saved decisions, queue state and markers; removing markers and resubmitting is not recovery.

## Regression entry points and limits

Default `npm test` covers settlement paging, maintenance, approval continuation, state updates and close behavior. MySQL acceptance uses independent random schemas and synthetic providers:

```bash
BAILING_USAGE_TEST_MYSQL=1 BAILING_APPROVAL_CONTINUATION_TEST_MYSQL=1 \
node --import tsx --test --test-concurrency=4 \
  'src/modules/usage/*.test.ts' src/app/kernel-usage-lifecycle.mysql.test.ts \
  src/app/approval-continuations.mysql.test.ts
```

Fixtures require a dedicated MySQL on local `127.0.0.1:16307`, an empty root password, and permission to create/drop test databases. Never point them at shared or production databases. Approval acceptance includes actual child-process SIGKILL, recovery in a different PID, lost COMMIT acknowledgements, concurrent continuation and missing-migration rollback. This establishes behavior in the fixtures, not real-provider availability, physical power-loss durability or production business acceptance. Skipped database tests do not count as passes.

See the [capability and public evidence index](IMPLEMENTATION_STATUS.en.md) for implementation and test links.
