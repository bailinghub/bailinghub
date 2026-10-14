# Core v0.9.3 patch upgrade guide

[简体中文](UPGRADE_v0.9.3.md)

Upgrade public Core 0.9.2 to 0.9.3 for bounded bodies, graceful notification shutdown and executor-DLQ replay, plus read-only maintenance metrics. This guide concerns Core only. MCP / Agent Client SDK and DSH remain at 0.7.0; ACC, clients and independent Hosts release and deploy through their own procedures.

## Preserve data and coordinate writers

Back up the target database. Retain configuration and credentials, attachments, original jobs/requests, approvals, dead letters, queues and previous artifacts. Stop new work, coordinate all writers sharing the state database, and reconcile in-flight notifications and delivered/unknown receipts before draining old instances.

Retain original Job, request, operation, invocation, approval decision and DLQ IDs. The new shutdown guarantee requires new code; an old instance closing does not prove that untracked notifications finished. After a drain timeout, retain same-instance resources and retry later rather than forcing store closure or blindly resending unknown messages.

## Select artifacts and migrate explicitly

Use formal `v0.9.3` source, npm packages or images. Verify Tag/commit, version and artifact digest. Installer and prebuilt-image Compose defaults become 0.9.3; existing `.env` files are preserved and dependency versions remain unchanged.

Apply outstanding files through the official explicit migrator. Source installations use:

```bash
npm run db:init
```

Embedded integrations use official `migrateBailingHubCoreSchema` and verify the complete `BAILINGHUB_CORE_ARTIFACT_V1` artifact manifest. Startup does not migrate. Recorded SQL is skipped; do not manually edit historical SQL or migration records.

| Migration added since 0.9.2 | Purpose |
| --- | --- |
| `067_delivery_dlq_replay.sql` | Add `delivery_kind`, `notification_job_id` and `executor_replay_key` to `bz_delivery_dlq`, plus `delivery_replay_keys` to `bz_jobs` for original notification binding and permanent admission markers |

067 preserves old data without bulk-guessing historical DLQ kinds. Replay verifies original jobs; ambiguous bindings fail explicitly. Apply 067 before all new Core MySQL DLQ reads/writes, including native-channel record/get. Earlier upgrades also apply all missing preceding migrations; see the [0.9.2 guide](UPGRADE_v0.9.2.en.md) for 065/066 support.

## Match adapters and callers

Upgrade official MySQL/JSONL state adapters together with the DLQ ledger. Custom ledgers supply optional `ensureExecutorReplay`; state adapters supply `RuntimeStateStore.requeueDeliveryJobOnce`, with original-binding checks, atomic admission/marker writes and marker preservation under ordinary updates. Unsupported executor replay returns `delivery_dlq_replay_unavailable`, without redirecting to a same-named native channel. JSONL remains single-writer.

Replay retains full original notification-child input, recipient and request/job identities; do not rerun its business parent to deliver a message. `queued` means queue admission. Verify execution and recipient receipt separately. Permanent markers prevent the same DLQ from admitting twice. A later failure creates a new operational DLQ record. Native channels gain no exactly-once guarantee across systems; reconcile partial or unknown receipts.

Managed integrations retain existing `tick()` and `close(drainMs)` calls. Close waits for accepted notification work and dynamic children within its shared budget. Observe fixed-category failure/timeout metrics without treating counts as business or receipt evidence.

## Verify the upgrade

1. Check new artifact identity, the target migration ledger and actual 067 columns. Verify `/health`, the console and existing smoke checks. Optionally run explicit read-only diagnostics:

   ```bash
   npm run --silent doctor -- --deployment --url http://127.0.0.1:18900 --readiness --json
   ```

   This performs no migration and does not establish image digest or complete database identity. Read exit codes and unchecked scope; see [deployment diagnostics](DEPLOYMENT_DIAGNOSTICS.en.md).
2. In isolation, check within-budget and oversized tool bodies/attachments, including absent/understated lengths and multibyte text. Overflow after a dispatched write retains the original unknown outcome; recovery must not dispatch another business write.
3. Replay a failed executor-notification DLQ and verify only its original child is admitted. Concurrent retries and lost acknowledgements cannot duplicate admission or rerun the business parent. Real recipient receipt requires separate acceptance.
4. Verify delayed callbacks, delivery creation and DLQ writes block resource closure. A timeout preserves resources and permits same-instance retry. This does not test full notification recovery after SIGKILL.
5. If protected `/metrics` is enabled, inspect fixed-category in-flight work, failures, recent-run age, drain timeouts and last-page progress. Scraping starts no maintenance or provider request; process-local counts are not persisted backlog.

See [Core reliability](CORE_RELIABILITY.en.md#core-v093-http-and-notification-fixes) for synthetic tests and dedicated MySQL regressions. Skips are not passes. Release acceptance does not replace target-environment deployment acceptance.

## Rollback boundary

067 is additive. A code rollback preserves DLQ kind/binding/replay identity, `delivery_replay_keys`, queues, original records and migration history. Never delete markers and resubmit. Stop related writers and reconcile admitted/in-flight notifications and recipient evidence before deciding on rollback.

**Old versions do not automatically accept the newer migration ledger.** An older complete schema manifest or migrator may fail closed on unknown 067 history. Additive columns do not mean old readiness or migration paths must pass. Verify the intended older artifact against the retained new schema/ledger in an isolated copy and define recovery; deleting migration rows to bypass checks is not an acceptable shortcut. Old code also loses this release's body, graceful-close and replay-deduplication guarantees.

Restoring an older backup requires reconciling business effects, receipt and charges since the backup. A database restore does not undo those external effects. Do not blindly resend unknown deliveries; business services retain their own idempotency and final authorization.

[Release notes](RELEASE_NOTES_v0.9.3.en.md) · [Reliability contract](CORE_RELIABILITY.en.md) · [Compatibility policy](COMPATIBILITY.en.md)
