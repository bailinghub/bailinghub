# Core v0.9.4 patch upgrade guide

[简体中文](UPGRADE_v0.9.4.md)

Upgrade public Core 0.9.3 to 0.9.4 to remove the unused DOCX CLI dependency chain and add durable notification intents for new terminal transitions and approval prompts, with bundled console management. This guide covers Core only. SDK/DSH remain at 0.7.0; ACC, clients and independent Hosts release and deploy separately.

## 1. Preserve consistent backups and pause writers

Retain the current code/image digest, configuration and credentials, attachments, state/configuration databases, JSONL, migration history and previous artifacts. Databases may differ: terminal tasks belong to the state database, while approvals and their prompts belong to the configuration database. Identify and back up each actual target. Notification snapshots contain business bodies and destinations; protect them like original task data and exclude them from public reports.

Stop new work, coordinate all writers sharing these stores, and drain old instances. Reconcile in-flight notifications, original jobs/requests/approvals and external receipts. Preserve IDs, dead-letter replay markers and queues. Successful old-instance shutdown does not establish receipt of intents that were never persisted; upgrading does not bulk-notify historical completed tasks or old approvals.

## 2. Verify artifacts and explicitly migrate

Use formal `v0.9.4` source, `bailinghub@0.9.4` or images, checking Tag/commit, version and artifact digest. Installer and prebuilt Compose defaults become 0.9.4, preserving existing `.env` files. DOCX now uses a pinned repository-local library archive; changing only the version field or retaining the old dependency tree is insufficient. Operators need not modify upstream sources themselves.

| Migration added since 0.9.3 | Purpose |
| --- | --- |
| `068_notification_outbox.sql` | Create `bz_notification_outbox` for events, snapshots, state, retries and leases; add nullable `event_id` and a unique index to `bz_delivery_dlq` |

Migration 067 and earlier files are unchanged. Use the new artifact's official explicit migrator to apply all pending SQL, checking the full `BAILINGHUB_CORE_ARTIFACT_V1` manifest. Do not edit historical SQL or migration records; Kernel startup does not migrate automatically.

```bash
npm run db:init
```

**This CLI migrates only the currently configured `state.mysql`.** If approvals use an independent MySQL configuration database, separately invoke official `migrateBailingHubCoreSchema({ mysql: configurationDatabase })` with the deployment's verified target connection settings. A shared database needs one invocation; do not migrate the same database concurrently. JSONL state needs no SQL migration, but its MySQL configuration database still needs 068. See the [Kernel Host API](KERNEL_HOST_API.en.md) for entry points and authority. Earlier upgrades must also apply preceding migrations; see the [0.9.3 guide](UPGRADE_v0.9.3.en.md).

Migration creates no historical notifications. JSONL uses synced compound records and one writer; never let old and new instances write the same log concurrently. Incomplete tails can recover under store rules; damaged complete records stop processing and must not be removed from the middle of history merely to force startup.

## 3. Match stores and receivers

Upgrade official state/configuration stores and DLQ ledgers with Core. Custom stores need the optional durable ports and their transaction, lease-token and original-event retry semantics. Unsupported stores retain the old best-effort compatibility path, with unavailable management capability, not reliable recovery.

Webhook receivers persist deduplication records keyed by `X-Bailing-Event-Id` or signed-body `notification_event_id`. Network errors, 429 and 5xx can retry with bounded backoff; ordinary 4xx stop. An automatic cycle permits at most six send attempts and retains an exhausted failure. A receiver success followed by a lost local acknowledgement can send the same event again; leases do not guarantee exactly-once external effects.

Native partial/unknown receipt or expired in-flight claims become `uncertain`. The bundled Tasks notification view permits retry only with `runs:write` and explicit duplicate-risk verification. A changed state conflicts rather than overwriting newer state. Native-event-linked dead letters retry through the outbox only; 067 executor dead letters still requeue only the original notification child. Recovery never reruns the business parent, and notification `completed` does not mean a person has read it.

Embedded hosts retain existing fair `tick()` and `close(drainMs)` calls. Graceful close stops scanning and waits for accepted work; subsequent instances recover remaining durable records. Ordinary alerts and arbitrary external extensions are outside this durability guarantee.

## 4. Accept the upgrade

1. Check artifact identity, both actual database roles' migration history/068 table and index, `/health`, readiness, console and existing smoke. Optional read-only `npm run --silent doctor -- --deployment --url http://127.0.0.1:18900 --readiness --json` neither migrates nor independently confirms every database identity or image digest.
2. Use isolated data and local receivers to verify atomic terminal/approval intent storage. After interruption and restart, recover the same notification event without increasing business dispatch count. Verify receiver deduplication when processing succeeds but acknowledgement is lost.
3. Verify stale workers cannot acknowledge successor leases, uncertain native receipt stops automatic replay, read-only console users cannot retry, and stale observed states return 409. Preserve 067's original-notification admission deduplication.
4. Verify existing DOCX paths in the console and actual npm consumption. Public gates include `npm run docx:vendor:verify-upstream`, `npm run docx:test`, `npm run docx:browser:test` after the console build, and `npm run audit:deps`. Zero raw audit findings do not make arbitrary documents safe.
5. If protected `/metrics` is enabled, check fixed `jobs` / `approvals` availability, persisted state counts, pending age and expired leases. Reading metrics never sends notifications, and unsupported ports do not invent zero backlog. No outbox cleanup policy is included; monitor growth.

See [durable notifications](NOTIFICATION_DURABILITY.en.md) and [dependency verification](DOCX_DEPENDENCY.en.md) for regression entry points. Conditional skips are not passes; synthetic release checks do not replace live-channel deployment acceptance.

## 5. Rollback limits

First stop admission, notification workers and shared writers. Preserve outbox, dead letters, original tasks, queues, receipts and migration history; reconcile sent and uncertain notifications. **Old code cannot process the new outbox, and old schema manifests may reject migration 068.** Additive tables do not establish safe direct downgrade. Never delete migration records, events or replay markers to bypass checks.

Validate the intended code/configuration/database combination in an isolated copy. Restore backups as a consistent set when needed, separately reconciling business and messages after the backup point; database restore cannot undo an external refund or sent notification. Returning to 0.9.3 also restores its old DOCX dependency chain and time-limited risk, and loses new durable notifications. It cannot retain claims that dependency remediation or crash recovery remain effective.

[Release notes](RELEASE_NOTES_v0.9.4.en.md) · [Notification contract](NOTIFICATION_DURABILITY.en.md) · [Compatibility policy](COMPATIBILITY.en.md)
