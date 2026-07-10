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
