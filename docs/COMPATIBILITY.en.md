# Compatibility And Upgrade Policy

## Core 0.10.0 compatible extensions

Pair Core 0.10.0 with MCP / Agent Client SDK 0.8.0 and DSH 0.8.0 for optional Agent knowledge, tool guidance and explicit model-output policies. No new SQL is added relative to public 0.9.4. Existing clients retain inline delivery and old model policies are not changed automatically. Readiness now checks actual state/configuration resources and full migration digests; custom MySQL stores must expose `schemaReadinessDb` or fail closed. See the [0.10.0 upgrade guide](UPGRADE_v0.10.0.en.md) for configuration rollback and independent-consumer boundaries.

## Current 0.9.x upgrade path

Core 0.9.2, 0.9.3 and 0.9.4 add migrations 065/066, 067 and 068 respectively. **A patch does not imply no schema migration or a restart-only upgrade.** Read the [0.9.2](UPGRADE_v0.9.2.en.md), [0.9.3](UPGRADE_v0.9.3.en.md) and [0.9.4](UPGRADE_v0.9.4.en.md) guides for the selected path. Preserve original jobs, approvals, notifications and migration records. Historical pairing notes below do not replace the target-version guide.

## Core 0.9.1 patch upgrade

Relative to 0.9.0, this patch fixes asynchronous usage shutdown and updates public documentation/general security governance. There are no new APIs, SQL, plan rules, or client features. SDK 0.7.0 / DSH 0.7.0 remain unchanged. Old-version close returning does not establish that usage work has finished. Reconcile original requests before replacing artifacts; retry a new-version usage-drain timeout on the original instance. See the [0.9.1 upgrade guide](UPGRADE_v0.9.1.en.md).

## Core 0.9.0 release pairing

Pair Core 0.9.0 with SDK 0.7.0 / DSH 0.7.0 for the optional model billing gateway. Hosts retain orchestration, existing business authority, approvals and original-call recovery. Public 0.8.0 upgrades apply outstanding 063/064 migrations and retain real data, with no test-schema purge. Periodic sale price and allowance are separate; original grant snapshots and ledger remain. Hosts opt into model plans explicitly; existing business-tool-only hosts need not enable billing. See the [0.9.0 upgrade guide](UPGRADE_v0.9.0.en.md).

> Core 0.8.0 task enrollment persists on original Agent Sessions. Do not downgrade an enrolled deployment to a version that ignores enforcement markers. See [upgrade boundaries](UPGRADE_v0.8.0.md).

BailingHub follows SemVer for public releases.

Before `1.0.0`, the project may still adjust public contracts, but breaking changes must be documented clearly in release notes and changelog entries.

Version numbers express compatibility intent, not deployment effort. Compatible bug fixes may require additive migrations. New optional features may require explicit capability negotiation or paired clients. Before 1.0, incompatible adjustments still require an explicit migration path; 1.0 must define its stable API and support/deprecation policy before those commitments take effect. After 1.0, incompatible public API changes require a major version.

## Stable Public Surfaces

The following surfaces should be treated as public:

- HTTP APIs documented in the contract docs;
- tool call and callback signature shape;
- OpenAPI `x-agent-capability` fields;
- SDK package behavior;
- database migration ordering;
- Docker demo and installer entry points;
- configuration schema files under `schemas/`.

## Database Migration Rules

- Add new numbered SQL files instead of editing already released migrations.
- Prefer additive schema changes.
- New non-null columns must have defaults.
- Avoid destructive operations such as drop, rename, or type changes in minor versions.
- Use transition windows for major schema changes.
- Keep necessary data backfills in separate numbered migrations; additive DDL can still lock tables or need capacity planning.
- Unknown ledger entries and checksum conflicts fail closed. Do not remove ledger rows to bypass validation.
- `npm run db:init` migrates only `state.mysql`. A separate MySQL configuration store requires the official `migrateBailingHubCoreSchema` entry point as well. Migrate a shared database only once, never concurrently. JSONL state needs no SQL migration, but a MySQL configuration store still does. Startup does not run migrations.

See [SQL rules](../sql/README.md) and [Kernel Host API](KERNEL_HOST_API.en.md). An additive schema does not establish that an older artifact accepts the new ledger or durable state.

## File-Level Customization

Tracked default files should remain upgradeable. Operator customization should use `.local` overlay files when supported, such as executor brain profiles and prompts.

## Contract Changes

When public contracts change, update together:

- contract docs;
- SDK examples;
- schemas;
- changelog;
- smoke or contract tests.

Use distinct names for incompatible semantics and, where safe, a transition window spanning at least one complete minor release. State deprecation/removal versions and the actual diagnostic entry point. This is a change policy, not evidence that every existing deprecated field already emits a warning. Security fixes that cannot safely accept both forms must document an alternative migration procedure.

## Upgrade Goal

Operators should be able to upgrade the open-source core without losing local secrets, runtime state, or deployment-specific customization.

1. Pin current and target commits/artifact digests and read every applicable upgrade guide; do not update a running checkout from a floating branch.
2. Identify state/configuration databases, JSONL, attachments and local configuration. Keep consistent backups and old artifacts, and test the intended restoration set in isolation.
3. Stop admission and coordinate all writers sharing those stores. Drain accepted work and reconcile original calls, approvals and notification receipts. A timeout or unknown result must not become a replacement business write.
4. Validate the target manifest and each complete database ledger, then explicitly run the official migrator for each distinct MySQL store.
5. Check artifact identity, readiness, permissions, approvals, notification recovery, clients and receiver deduplication before restoring admission. No `BREAKING` heading does not mean no migration work.
6. Test rollback compatibility first. Never delete migration rows, task-enforcement markers or notification records to make old code start. Restoring a database cannot undo external business effects.

The [read-only upgrade planner](UPGRADE_PLAN.en.md) compares explicitly supplied artifacts and sanitized ledger snapshots. Offline comparison is not a live database check, proof of restorable backups or rollout approval.

## Instance Branding And Platform-Managed Upgrades

The instance name, browser title, metadata, logo, favicon, and login copy use the
stable `InstanceBrandingProvider` contract. The console and public
`GET /branding` endpoint depend only on that contract, not on a particular
database or hosting platform.

- The open-source edition uses the local provider and persists settings in
  `bz_instance_branding`.
- A platform-managed deployment replaces that provider at its composition root while
  keeping the same API and console.
- The upgrade process may import the local record into the platform once, then
  switch ownership to the platform provider.
- After takeover, the local page is read-only and may link to the platform
  management page. The local row remains migration evidence, not a second
  source of truth.
- Platform and local storage must never be dual-written.
- A temporary platform read failure may fall back to the built-in display
  defaults, but must not restore local write access.

Branding is instance presentation only. It does not extend the ACC core and
must not carry business authorization, secrets, custom HTML/CSS/JavaScript,
redirects, or other executable configuration.

## Embedded Widget Contract

The hub-hosted `widget.js` is a public wire surface because an instance upgrade
updates every embedding page. Stable fields include the `data-entry`,
`data-open`, and `data-ticket` script attributes, the documented chat endpoint
family, and the `window.BailingChat` APIs.

The optional rich-content extension evolves under
`window.BailingChat.rendererApiVersion`. Adding a new renderer type is
compatible when older widgets and hosts can still show its fenced payload as a
safe code block. Changing an existing type's payload meaning, lifecycle, or
trust boundary requires a renderer contract major version or a new type with a
transition window. The widget core remains dependency-free; see
[WIDGET_RENDERERS.en.md](WIDGET_RENDERERS.en.md) for registration, cleanup, and
fallback rules.

The `bailing-form` v1 addition under `bailing.contract.v2.14` follows that
compatibility rule:

- Existing `{message,...}` chat requests are unchanged.
  `interaction_response` is an optional alternative input to
  `POST /chat/:entry`. This public Chat addition is outside
  `bailing.client-api.v1` and does not change Client API, Kernel Host API, ACC,
  or SDK versions.
- The official widget adds the built-in `bailing-form` type. Older or custom
  clients still fall back to its safe fenced code block. A custom client should
  advertise `client_capabilities.renderers:["bailing-form"]` only after it
  implements the complete validation and response lifecycle.
- The renderer `mount` context gains optional `message` and `respond`
  properties. Existing JavaScript destructuring ignores additional properties,
  so both `WIDGET_API` and `rendererApiVersion` remain 1.
- A form response creates a new job in the same thread. It changes neither the
  source job's terminal state, the `bailing.chat.stream.v1` event set, nor the
  database schema. Existing proxies, SSE clients, and upgrade flows need no new
  waiting state.

The official `widget.js` and Chat endpoints ship from the same Hub artifact, so
a normal upgrade obtains both rendering and response handling. Clear any
separately cached legacy widget during rollout, and do not advertise the new
capability from a custom client against an older Hub.

## URL Tool Catalog Access Policy Upgrade

The release that introduces `053_tool_spec_access_policy.sql` adds two nullable columns to `bz_tool_providers`. Keep the normal backup, `db:init`, and restart order. The public configuration surface always has exactly two values, `signed_required` and `public_allowed`; new URL providers default to the former.

For URL providers created before this change, the new database field remains `NULL` and is derived at read time as the internal, read-only migration state `legacy_unverified`. It is not a third public policy: it is not accepted as a writable create or update value and is never a selectable option. The console list labels it “Pending confirmation (historical configuration),” and neither real policy is preselected in the editor. Its only purpose is to avoid guessing that an undeclared historical endpoint is public or protected. Until an operator selects a policy, the cached spec remains in place, refresh keeps the previous signed-fetch behavior, and the access probe records `skipped`. Inline providers do not persist this URL-only state.

“Pending confirmation” does not make the whole record immutable. An operator may still disable the provider or save descriptive, governance, retrieval, and other fields that do not alter catalog access. Those changes do not force a policy choice. Selecting `signed_required` or `public_allowed` is required only before changing `spec_url`, the provider `secret`, `auto_refresh_min`, re-enabling a disabled provider, or another sensitive action that changes or resumes catalog reads.

Resolve existing URL providers one at a time:

1. Confirm that the catalog URL is the final direct address and does not redirect.
2. Before a catalog-sensitive action listed above, select `signed_required` when the business endpoint verifies the provider signature. Select `public_allowed` only when public catalog discovery is intentional. Saving persists the selected public policy and resolves the internal migration state.
3. Save and refresh manually. Changing the URL, secret, or policy clears previous evidence.
4. `signed_required` is `protected` only when the signed primary request returns 2xx and unsigned plus invalid-signature probes each return 401/403/404. A negative 2xx is `public`; redirects, 429, 5xx, and network errors are `inconclusive`. A 404 on the signed primary request is a failure, not protection evidence.
5. Confirm `Cache-Control: private, no-store` and verify that reverse proxies or CDNs cannot cache or rewrite a protected catalog.

Refresh failures preserve the previous cache. Each request is bounded to 10 seconds and the successful primary response is limited to 5 MiB. Preserve the 053 columns, historical configuration and ledger during rollback, but first test whether the specific old artifact accepts that ledger and data. Nullable columns alone do not establish compatibility. Restore a pre-upgrade snapshot only as a consistent set with the old application, and reconcile subsequent external effects. Do not delete the ledger entry or drop the columns independently.

This policy governs catalog discovery only. It does not change ACC, tool-call signatures, route allowlists, approvals, idempotency, or final business authorization.
