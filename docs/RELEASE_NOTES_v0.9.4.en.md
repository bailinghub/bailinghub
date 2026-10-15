# v0.9.4: DOCX dependency remediation and durable notifications

[简体中文](RELEASE_NOTES_v0.9.4.md)

Version date: 2026-10-15. A patch from public Core 0.9.3.

An after-sales task finishes, but Core is killed before sending its result notification. Rerunning the business task could issue a second refund, while graceful shutdown alone cannot recover this gap. BailingHub 0.9.4 commits terminal state and notification intent together in built-in stores, then resumes the original notification while preserving the business result. It also removes an unused vulnerable CLI dependency chain from DOCX parsing and adds notification operations to its bundled console.

## Fixes

### Retain the DOCX parser and remove its CLI dependency chain

Core file context and console knowledge-base import retain Mammoth 1.12.0's original parsing sources. The explicitly modified `@bailinghub/mammoth-library@1.12.0-bailinghub.1` distribution keeps upstream library sources, types, browser adaptations and the BSD-2-Clause license, while removing the unused CLI and `argparse → sprintf-js` chain.

Core, console, source exports and Docker use one pinned archive; the npm artifact bundles the library and its runtime dependencies. The former temporary audit exception is retired. Gates require zero raw findings in both dependency trees and separately query direct advisories under the original `mammoth@1.12.0` identity. Provenance integrity and individual source files are publicly verifiable. This remediates this project's distribution, not upstream sprintf-js, and does not establish that arbitrary DOCX files are safe. See [DOCX dependency verification](DOCX_DEPENDENCY.en.md).

### Persist business results and notification intents together

The MySQL state store commits terminal Job state and notification intents together. Approval creation and its notification share a transaction in the owning configuration database, which may be separate. JSONL stores both in one synced record and remains a single-writer implementation.

Coverage includes callbacks from new terminal transitions, configured result delivery, approval prompts and dead-letter recording for failed notification children. Startup and maintenance recover pending intents with bounded batches, leases, retries and stale-worker fencing. Historical completed tasks or old pending approvals are not bulk-converted into new notifications, and notification recovery never reruns the business parent. Ordinary monitoring alerts and legacy adapters without durable ports remain best effort.

Webhooks wait for real HTTP responses and identify the original event through `X-Bailing-Event-Id` and signed-body `notification_event_id`. Lost acknowledgements can cause redelivery; receivers must deduplicate. Exhausted retry cycles retain failed records, so at-least-once semantics do not promise unlimited retries or guaranteed receipt. Native partial/unknown delivery or expired in-flight claims become `uncertain`, requiring receiver verification before manual handling. See [durable notifications](NOTIFICATION_DURABILITY.en.md).

## Bundled console and persistent metrics

The bundled console's Tasks notification view provides type/status filters, summaries and failed-event retry. Reading requires `runs:read`; retry requires `runs:write`, and unknown receipt requires explicit confirmation of duplicate risk. The admin API compares the observed state before mutation and handles only the notification, never business re-execution.

The optional protected `/metrics` endpoint adds outbox availability, status counts, oldest pending age and expired lease counts under fixed `jobs` / `approvals` sources. It reads persistent aggregates without body, recipient, event or tenant labels, and does not invent zero backlogs for unsupported stores. Automatic cleanup and historical archival are not included; operators should monitor growth.

## Upgrade and boundaries

- **Core operators:** back up original artifacts, configuration, state/configuration databases and JSONL, then explicitly apply `068_notification_outbox.sql`. Both independent state and configuration databases need migration. `npm run db:init` handles only the configured MySQL state database; use the official migration API separately for an independent configuration database.
- **Embedded and custom-store developers:** use matching built-in stores or implement the optional durable ports' transaction/lease semantics. Continue existing `tick()` and `close(drainMs)` calls. Legacy third-party stores do not gain a durability guarantee through the compatibility path.
- **Notification receivers:** deduplicate stable event IDs and verify external outcomes. Notification `completed` may mean handoff to a durable executor, not a person reading it. Native-event-linked dead letters recover through the outbox only; 067's original executor-notification replay remains available.
- **Independent projects:** MCP / Agent Client SDK 0.7.0 and DSH 0.7.0 remain unchanged. ACC, clients, independent Hosts and individual deployments release or upgrade separately.

Migration 068 creates the outbox and adds a nullable dead-letter event reference with a unique index. Migration 067 and earlier files are unchanged, and historical notifications are not invented. Old code cannot process the new outbox or undo sent messages; preserve events, dead letters, receipts and migration history, using a consistent backup and reconciliation procedure. See the [upgrade guide](UPGRADE_v0.9.4.en.md).

Public regressions cover upstream parsing compatibility, real npm consumers, browser console behavior, actual JSONL SIGKILL, MySQL transactions/lost acknowledgements, lease fencing, approvals, migration 067 to 068 and original-notification replay. They use synthetic data and local receivers, not live-channel receipt, deployment acceptance or production rollback drills. They do not guarantee recovery from disk corruption or unverified external effects.

[Upgrade guide](UPGRADE_v0.9.4.en.md) · [Full changelog](CHANGELOG.en.md) · [Capability and evidence index](IMPLEMENTATION_STATUS.en.md) · [Previous release](RELEASE_NOTES_v0.9.3.en.md)
