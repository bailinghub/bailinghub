# v0.9.3: bounded bodies and reliable notification shutdown

[简体中文](RELEASE_NOTES_v0.9.3.md)

Version date: 2026-10-14. A patch update from public Core 0.9.2.

Core previously buffered a complete oversized tool response or remote attachment before rejecting it. Graceful shutdown could release resources before callbacks, notifications or dead-letter records finished, and executor-notification replay could select a native channel incorrectly. BailingHub 0.9.3 fixes these boundaries and adds read-only visibility into existing maintenance.

## Fixes

### Enforce HTTP and attachment limits while reading

Business-tool HTTP bodies have a separate default **5 MiB** transport budget. Excessive `Content-Length` allows early rejection; absent or understated lengths and compressed responses still undergo chunk-by-chunk checks of actual fetch-decoded bytes. Overflow requests cancellation and discards partial contents. Model views default to **8 KiB** and audit payloads use **64 KiB**, now measured as UTF-8 bytes rather than character counts.

Remote files retain configured `max_bytes` (**20 MiB** by default), and channel attachments have a **20 MiB** download budget, both checked during reading. Download bounds do not guarantee archive-expansion or parser resource usage.

HTTP 200 headers and partial contents do not establish a completed write. A dispatched write with body loss or overflow retains its original Job / invocation, idempotency identity and unknown outcome without automatic redispatch.

### Drain actual notification work during graceful close

Each Kernel tracks actual callback, delivery, approval-webhook, alert and DLQ work, draining it before resource closure within the shared close budget. Accepted work can register child continuations. Standalone also waits for already-started maintenance producers after stopping timers. Timeouts retain same-instance work and dependencies for a later `close()` attempt.

This covers graceful shutdown; completing a drain does not mean every message was delivered. This release does not provide a durable outbox for all notification intents or promise complete HTTP notification recovery after SIGKILL.

### Replay the original executor notification child

Native channels retain native delivery. Executor DLQs verify kind, original child, recipient and content before requeueing that notification child, retaining full input and request/job identities without rerunning its business parent.

Admission and a permanent marker are saved atomically for the same DLQ. Concurrent retries, a lost admission acknowledgement or failed resolve cannot admit it again. `queued` acknowledges admission, not recipient receipt; a later failed execution creates a new DLQ that may be handled separately. Conflicting bindings fail explicitly. Unsupported custom adapters return unavailable rather than using the wrong channel. JSONL remains single-writer.

## Additional maintenance metrics

The existing optional `/metrics` endpoint adds in-flight work and oldest age, completed/failed totals, recent-run timestamps, drain state/timeouts, latest settlement/approval page progress and settlement backoff.

The maintenance collector reads owner-local memory without querying business details, triggering reconciliation or contacting models. Labels use fixed categories, excluding account, principal, job, payload and credential data. Counters reset with owner recreation. Latest-page progress is not persisted total backlog, and continuation completion is not a receipt acknowledgement. See [operations](OPERATIONS.en.md).

## Who should upgrade

- **Core operators** using business HTTP tools, remote attachments, notifications or DLQs should upgrade. Preserve configuration, data, queue state and rollback artifacts before explicitly applying 067.
- **Embedded and custom-adapter developers** retain fair `tick()` calls and `close(drainMs)`. Executor replay requires matching `ensureExecutorReplay`, `RuntimeStateStore.requeueDeliveryJobOnce` and atomic semantics.
- **Business-backend and client integrators** retain original invocation identities, business idempotency and final authorization, and check response download budgets. MCP / Agent Client SDK 0.7.0 and DSH 0.7.0 remain unchanged. ACC, clients and independent Hosts release and deploy separately, outside this Core patch.

## Upgrade, verify and understand limits

Since 0.9.2, `067_delivery_dlq_replay.sql` adds DLQ kind, original notification child/replay identity and a separate Job admission marker. Apply 067 through the official explicit migrator before all new Core MySQL DLQ reads/writes, including native-channel record/get; startup does not migrate automatically. Legacy rows are not bulk-classified by guesswork; replay verifies original jobs. See the [upgrade guide](UPGRADE_v0.9.3.en.md).

Public regressions cover bounded bodies, Unicode budgets, unknown write outcomes, graceful close, original notification replay and metrics isolation. Dedicated MySQL tests cover upgrading from 0.9.2, concurrent admission, acknowledgement exceptions after real COMMIT, failed resolve and store reopening. Notification tests check storage interruption boundaries, not actual process killing, live-channel receipt or production acceptance. See [reliability and regression entry points](CORE_RELIABILITY.en.md).

Dependency versions are unchanged. The existing exact Mammoth library-only audit exception still expires at **2026-11-09 00:00 UTC**, without broadening or renewal; this does not claim an advisory-free dependency audit.

[Upgrade guide](UPGRADE_v0.9.3.en.md) · [Full changelog](CHANGELOG.en.md) · [Capability and evidence index](IMPLEMENTATION_STATUS.en.md) · [Previous release](RELEASE_NOTES_v0.9.2.en.md)
