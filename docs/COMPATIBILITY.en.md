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
