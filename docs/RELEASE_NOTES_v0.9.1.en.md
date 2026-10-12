# v0.9.1: asynchronous model shutdown and public capability evidence

[中文版](RELEASE_NOTES_v0.9.1.md)

After an assistant requests an image, the Hub promptly returns the original request's pending state. Provider completion and usage settlement follow later. If a host evicts an instance, upgrades, or exits at that point, a finished HTTP request does not mean its background work is finished.

Core 0.9.1 fixes that shutdown boundary by waiting for the original instance's usage background work and subsequent settlement before closing resources. It also includes a public capability index and general security governance already on main. This is a patch release with **no new HTTP/API, SQL migration, plan rule, client feature, or SDK/DSH release**.

## Shutdown fix

- Each `UsageRepository` separately registers model-tool completion, settlement after ordinary model responses, response cleanup, pending-usage reconciliation, and reference-price refresh through persistence.
- Kernel stops new HTTP admission and waits for foreground handlers, InHub, and execution queues to finish registering work. It then stops new usage work/maintenance and dynamically drains accepted completion and late settlement children before resource closure.
- All stages share the original `close(drainMs)` deadline. A usage-drain timeout preserves the original dependencies and closing state for same-instance retry; it does not redispatch a model request or business write.
- Image requests still promptly return HTTP 202. Ordinary text results also arrive before financial settlement. Original `operation_id` values, separate result/billing states, business authority, approvals, and unknown-outcome handling remain unchanged.
- Failed background work can retain durable pending/unknown evidence. Completed drain does not guarantee every record is settled or provide process-crash recovery or provider-task recovery.

The formal v0.9.0 close path did not explicitly register these usage continuations. Its Tag and existing artifacts remain unchanged; this fix does not rewrite their historical guarantees. See the [Kernel Host API](KERNEL_HOST_API.en.md) and [capability/evidence index](IMPLEMENTATION_STATUS.en.md).

## Public documentation and general security governance

The new Chinese/English capability index separates Core, business-system, local-host, and independent-adapter responsibilities, release facts, public test/reproduction paths, and uncovered scope. Thread context, visible conversation audits, and complete user-level long-term memory remain distinct. Existing tests are not presented as production adoption.

This release also includes dependency auditing with explicit exception checks, pinned GitHub Actions sources and minimal permissions, dependency-update and repository scanning configuration, plus public security self-assessments and Security Insights metadata. Assessments/metadata are repository governance and excluded from npm runtime packages and Docker build contents. Their existence does not establish that every control passes or that no residual risks remain.

## Upgrade impact

- Upgrading public Core 0.9.0 adds no SQL files and changes no existing migrations. Earlier versions still require their outstanding migrations; see the [upgrade guide](UPGRADE_v0.9.1.en.md).
- USD allowances, the uniform multiplier, periodic price/allowance, model catalogs, and business-governance contracts remain unchanged. This patch does not require new plan grants or replacement request IDs.
- Continue using **MCP / Agent Client SDK 0.7.0 and DSH 0.7.0**. Independent packages are not republished solely for this patch. Business declarations, signatures, authorization, and approval code need no patch-specific rewrite.
- Embedded hosts should read the new Core artifact's version and complete manifest, and continue using its public tick/close entry points. A Core artifact upgrade does not establish that hosts or clients have been upgraded, deployed, or accepted.

## Validation scope

[Tracker unit tests](../src/modules/usage/background-work.test.ts) check registration/drain mechanisms. [Actual Kernel + MySQL lifecycle tests](../src/app/kernel-usage-lifecycle.mysql.test.ts) check real Kernels, database transactions, and HTTP/standalone shutdown wiring. They cover delayed completion, late settlement, SQL locks, same-instance retry, two-Kernel isolation, ordinary text asynchronous settlement, independent cleanup/reconciliation, price persistence, and failed settlement retaining original results without redispatch.

Database cases require `BAILING_USAGE_TEST_MYSQL=1` and their dedicated test MySQL; providers and business data are synthetic. Test source or skipped tests are not passing runs. Real providers, business APIs, and deployments require their own acceptance. This page makes no production-adoption, comprehensive model-quality, or complete failure-recovery claim.

[Upgrade guide](UPGRADE_v0.9.1.en.md) · [Changelog](CHANGELOG.en.md) · [Previous release](RELEASE_NOTES_v0.9.0.en.md)
