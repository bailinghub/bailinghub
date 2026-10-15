# Durable notifications and recovery

[简体中文](NOTIFICATION_DURABILITY.md)

This page describes changes in the current source that have not yet shipped in a new product release. Historical Core v0.9.3 artifacts provide graceful drain and migration 067 dead-letter replay only. The scope is Core and its bundled console; ACC and independent consumers are unchanged.

## Persistence boundary

Built-in MySQL stores commit a terminal Job and its notification intents together. Approval creation and its notification use one transaction in the approval configuration database. These databases may differ; no cross-database transaction is assumed. JSONL stores append the Job and intents in one record, sync the journal, then publish memory state. JSONL supports one writer, not multiple processes sharing the same file.

The outbox covers callbacks, configured result delivery, approval prompts and dead-letter recording for failed notification children. New transitions create intents. Startup does not backfill historical terminal Jobs or pending approvals. Another legitimate business run creates another callback event, while explicit delivery routes retain `deliver_<parent>` and approvals retain `approval_<id>`. Native WeCom replies use the terminal event identity so an approved continuation can still notify its actual final result. Notification recovery does not rerun the business parent. General monitoring alerts remain best effort.

Events freeze the business snapshot, destination coordinates and display brand. Retries reuse the event ID. Signing secrets are read from existing credential sources rather than copied into the outbox. Payloads can contain business text and destination addresses and require the same protection and backup controls as Job data. Admin summaries and metrics omit them.

## Delivery semantics

- Startup and existing maintenance recover pending intents with bounded batches and retries. Graceful close stops new scans and drains accepted work; a subsequent owner recovers remaining durable work.
- Claim, renewal, completion and failure use an unexpired lease token. An old worker cannot acknowledge a replacement worker's claim.
- HTTP delivery waits for the response. The stable event ID appears in `X-Bailing-Event-Id` and the signed body's `notification_event_id`. Network errors, 429 and 5xx retry with backoff; ordinary 4xx stop. An automatic cycle allows at most six sending attempts. Receivers should persist event IDs for deduplication.
- A receiver may accept a request before the sender loses its acknowledgement. Webhook redelivery remains possible; leases and event IDs do not provide exactly-once external effects.
- Partial or unknown native-channel delivery, including an expired in-flight lease, becomes `uncertain` instead of an automatic full resend. An operator must check the receiver before retrying.
- `completed` can mean durable admission to the notification executor, not human receipt. Failed executor children retain migration 067's replay marker. Native dead letters linked to an outbox event use the outbox retry path exclusively.

States are `pending`, `processing`, `completed`, `skipped`, `failed` and `uncertain`. Manual retry preserves the ID and cumulative attempts while resetting the current cycle. Failed records are retained; automatic retention and archival are outside this change.

## Operations

The bundled console's Runs page adds notification delivery summaries, type/status filters and retry. Readers can inspect; retry requires `runs:write`. Uncertain delivery requires explicit duplicate-risk acknowledgement. No operation reruns the business parent.

Admin endpoints are `GET /admin/api/notification-outbox` and `POST /admin/api/notification-outbox/{event_id}/retry`. Retry requires `kind` and the observed `expected_status`; uncertain delivery additionally requires `allow_uncertain: true`. A changed state returns 409. Third-party stores without the optional durable ports retain legacy best-effort behavior and expose capability unavailable instead of claiming durability.

[Operational metrics](OPERATIONS.en.md) add availability, status counts, oldest pending age and expired leases with fixed sources `jobs` and `approvals`. Kinds partition these sources even when both stores share one database. No event, tenant, recipient or payload becomes a metric label.

## Migration, rollback and verification

Only [068_notification_outbox.sql](../sql/068_notification_outbox.sql) is added; historical migrations remain unchanged. Back up code, configuration, actual state/configuration databases and JSONL before upgrade. Migrate every database used by these stores. Migration creates the outbox and a nullable dead-letter association; it does not generate notifications from historical records.

Before rollback, stop new work and workers and preserve outbox, dead-letter and recipient evidence. Old code cannot process new outbox records, and database restoration cannot undo external messages. Restore a consistent code/configuration/database set and reconcile sent event IDs. Deleting intents or merely switching code is not a lossless rollback. Source tests are not a production upgrade or restore drill.

Public regression entry points:

- [Storage](../src/infrastructure/state/notification-outbox-storage.test.ts): JSONL recovery, MySQL atomicity/lost acknowledgements, lease fencing, approvals and retained migration history.
- [Runtime](../src/app/notification-outbox.test.ts): local receiver, same-ID delivery after SIGKILL, decided approvals, native uncertainty, child identities and stale acknowledgement rejection.
- [Lifecycle](../src/app/runtime-evidence-maintenance.test.ts): startup, stop and draining accepted work.
- [Admin API](../src/routes/admin-notifications.test.ts) and [legacy dead-letter routes](../src/routes/admin-runtime.test.ts): permissions, redaction, changed-state handling and one retry entry point.

Synthetic/local tests do not establish live-channel availability or production receipt. JSONL sync and MySQL commits depend on underlying storage; they do not cover damaged disks, arbitrary external stores or unverified external side effects.
