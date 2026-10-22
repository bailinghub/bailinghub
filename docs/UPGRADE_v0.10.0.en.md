# Core v0.10.0 upgrade guide

[简体中文](UPGRADE_v0.10.0.md)

This guide upgrades public Core 0.9.4 to 0.10.0. MCP / Agent Client SDK 0.8.0 and DSH 0.8.0 are independent releases. Existing business HTTP integrations, bundled chat and older Agent clients do not need new authorization to retain their existing features. New features depend on each consumer's configuration and version.

## Back up, drain and identify storage

Pin source/target Tags, complete commits and npm/image digests. Keep a consistent backup of configuration, secret-management material, attachments, JSONL, actual state/configuration databases, complete migration ledgers, original operations/invocations, approvals, notifications and old artifacts. Coordinate all shared writers, stop admission and drain accepted work. A close timeout does not prove completion; never run old/new JSONL writers concurrently.

**No SQL is added or changed relative to 0.9.4, and the migrator is unchanged.** An instance with complete 0.9.4 migrations should not manually add ledger entries for this release. Earlier versions still apply outstanding migrations through the official explicit migrator, including 068 on the 0.9.3→0.9.4 path. Identify actual state/configuration topology; migrate a shared database once. `npm run db:init` handles only the current `state.mysql`; migrate a separate configuration database explicitly through `migrateBailingHubCoreSchema()`. Startup does not execute DDL.

The [read-only upgrade planner](UPGRADE_PLAN.en.md) can compare artifacts and redacted ledgers. Offline `reviewable` status is not database inspection, backup recovery proof or permission to deploy.

## Readiness and custom Hosts

Readiness now inspects actual state/configuration resources, the artifact migration manifest and full SHA-256 digests. Missing/unknown migrations and digest conflicts remain not-ready. The probe does not repair them; external model/tool-source failures do not remove the whole instance from service.

Custom MySQL `RuntimeStateStore` implementations expose the optional `schemaReadinessDb` extension pointing to their actual read-only query resource. Absence now fails closed. Default `MysqlStore` already provides it without another pool. JSONL with a MySQL configuration database still checks that database; only pure JSONL without SQL configuration skips database inspection.

Embedded Hosts retain `tick()` and `close(drainMs)` and wait for boot-recovery target refresh, query, audit and requeue work before releasing resources. Deployment health, unchanged API signatures or a typecheck alone do not establish Fleet upgrade acceptance.

## Agent consumer pairing

1. Upgrade Core and check the original protocol first; refresh discovery for new requests only. Preserve saved request bodies/digests, operation/invocation IDs and authority bindings.
2. Hosts adopting MCP / Agent Client SDK 0.8.0 and DSH 0.8.0 verify the actual dependency tree, built artifacts and loaded versions. Core, a generic SDK and a complete host product have different audit scopes.
3. Larger arguments require every layer's new limit. Core cannot override an older client's independent 4/16 KiB check. Do not remove business meaning, stringify objects or bypass authentication to evade limits.
4. Read knowledge capabilities before explicitly selecting `on_demand` on a new turn. Protocol-defined 404/405/501 may fall back to inline; 401/403/5xx and unknown schemas are not success. Hints, references and pagination stay authority/revision/budget-bound. Bundled chat/embed/widget need no opt-in.
5. Guidance and execution summaries are references. Deduplication, summarization or omitted bodies must not remove machine constraints or original-result reconciliation.

## Configure model budgets explicitly

Old services are not changed automatically. To adopt the policy, set `defaultOutputTokens`, `outputTokenParameter` and `outputBudgetScope` together and keep the default at or below `maxOutputTokens`. Omit unknown `modelMaxOutputTokens` values rather than guessing. Recheck semantics when changing models or credentials. Do not apply chat policy fields to image services.

Older clients may use `max_output_tokens` as both default and ceiling. Keep the legacy policy until those clients adapt, or use an intentionally equal default/ceiling transition after confirming the parameter is compatible. A transition does not redefine the new contract. Parameter mismatches and oversize budgets are confirmed pre-dispatch failures, never automatic retries. A prepared but unadmitted old intent may be rejected by a changed policy and needs an explicit new operation; already admitted operations remain recoverable by their original IDs and snapshots.

The host adapter interprets output cutoff. Partial stream delivery or a missing final frame requires original-operation inspection first. Only a confirmed cutoff with the original terminal receipt can lead to a new segment under existing task authority. Core does not call the model for upgrade/acceptance automatically and never repeats completed tools. See [output budgets](MODEL_OUTPUT_BUDGET.en.md) and [host continuation](MODEL_CONTINUATION.en.md).

## Acceptance and rollback

- Verify exact artifact identity, complete migration ledgers and `/health/ready`; inspect real storage rather than configuration filenames alone.
- Use isolated data to check examples, unsaved protection, original approval arguments, read-only receipts and diagnostic filters/return paths. Large-argument tests can use read-only validation or a synthetic business system without changing customer pages.
- Verify new knowledge/budgets only for hosts adopting them; preserve old inline, old policy and original-operation recovery cases. Synthetic output is not real-provider long-answer acceptance or a verified price.

Before rollback, stop new writes, drain and preserve new original-call evidence and configuration revisions. No new DDL does not make a tag-only downgrade safe: old Core does not understand new knowledge endpoints or explicit budget policies and may return to its old default parameter. Validate the old consumer's inline fallback, old service policy and persisted records together in isolation; restore code/configuration as a consistent set if needed. Never delete approvals, unknown outcomes, migration entries or operations to bypass checks. Database restoration cannot undo external business actions.

[Release notes](RELEASE_NOTES_v0.10.0.en.md) · [Compatibility](COMPATIBILITY.en.md) · [Operations](OPERATIONS.en.md)
