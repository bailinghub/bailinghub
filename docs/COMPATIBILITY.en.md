# Compatibility And Upgrade Policy

BailingHub follows SemVer for public releases.

Before `1.0.0`, the project may still adjust public contracts, but breaking changes must be documented clearly in release notes and changelog entries.

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

## File-Level Customization

Tracked default files should remain upgradeable. Operator customization should use `.local` overlay files when supported, such as executor brain profiles and prompts.

## Contract Changes

When public contracts change, update together:

- contract docs;
- SDK examples;
- schemas;
- changelog;
- smoke or contract tests.

## Upgrade Goal

Operators should be able to upgrade the open-source core without losing local secrets, runtime state, or deployment-specific customization.

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

Refresh failures preserve the previous cache. Each request is bounded to 10 seconds and the successful primary response is limited to 5 MiB. The safest application rollback is to restore the old code while keeping the additive columns and migration ledger; the old version ignores them. Use the full pre-upgrade database snapshot only for a coordinated rollback with the old application. Do not delete the ledger entry or drop the columns independently.

This policy governs catalog discovery only. It does not change ACC, tool-call signatures, route allowlists, approvals, idempotency, or final business authorization.
