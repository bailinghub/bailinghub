# Changelog

This changelog records public, user-visible changes starting from the first public release.

For the current integration contract, use:

- [README.en.md](../README.en.md);
- [QUICKSTART.en.md](QUICKSTART.en.md);
- [CONTRACT.en.md](CONTRACT.en.md);
- [TOOLS.en.md](TOOLS.en.md);
- [SDK.en.md](SDK.en.md).

## Recording Rules

Each public version should describe:

- new capabilities;
- integration impact;
- database schema changes;
- validation commands;
- related docs.

## v0.1.2 - Server Token and Derived Credential Hardening

Released on 2026-07-17.

- Removed the public literal fallback from task tool tokens, job callbacks, and alert webhook signatures. Signing paths now fail closed when the root token is missing.
- Only development mode bound to a loopback host may run without a token. Production or non-loopback listeners require an explicit non-placeholder `BAILING_TOKEN` of at least 24 characters.
- Source and image Compose files no longer provide a predictable machine-admin token. The docs generate a random value, while the one-line installer continues to generate and persist one automatically.
- The tokenless development-admin fallback is also restricted to loopback mode, and the security scanner rejects legacy fallback expressions and predictable Compose admin tokens.
- Public HTTP, SDK, signature format, and database contracts are unchanged. Existing production or externally reachable deployments must set a strong `BAILING_TOKEN` before upgrading.
- Validation: `npm run typecheck`, `npm test`, `npm run security:scan`, and `npm run release:check`.
- Related docs: [RELEASE_NOTES_v0.1.2.en.md](RELEASE_NOTES_v0.1.2.en.md), [SECURITY.md](../SECURITY.md), and [QUICKSTART.en.md](QUICKSTART.en.md).

## v0.1.1 - Widget Operations and Stricter Integration Boundaries

Released on 2026-07-13.

- Chat entries can be paused or resumed from the console without removing embed code. Disabled entries hide the launcher and panel while server endpoints continue to reject access.
- Widget footer attribution can be shown, hidden, or customized. Existing entries keep the current BailingHub attribution by default.
- OpenAPI compilation fails closed for `cookie`, unknown, or missing parameter locations instead of silently mapping them to query. ACC `timeout_ms` remains integer-only, with an actionable diagnostic for quoted numeric strings.
- Application images publish to both Aliyun ACR and GHCR. GitHub main and release tags mirror to Gitee, README images render on both platforms, and community derivative and ecosystem collaboration principles are documented.
- Existing chat entries and public contracts remain compatible. Attribution reuses the existing `appearance` JSON, so no database migration is required.
- Validation: `npm run typecheck`, `npm test`, `npm --prefix web-admin run build`, and `npm run release:check`.
- Related docs: [RELEASE_NOTES_v0.1.1.en.md](RELEASE_NOTES_v0.1.1.en.md), [CHANNELS.en.md](CHANNELS.en.md), and [CONTRACT.en.md](CONTRACT.en.md).

## v0.1.0 - First Public Release Candidate

`v0.1.0` is the first public release candidate. It is intended for self-hosted evaluation, small pilot integrations, and architecture review.

Included:

- trigger routes;
- MySQL-backed runtime state;
- DB-backed job scheduling and lease recovery;
- tool providers and OpenAPI `x-agent-capability` governance metadata;
- centralized rate-limit ledger;
- approval intent and frozen argument snapshots;
- audit and trace records;
- Docker demo and demo business app;
- PHP, PHP 7, Node, and Python SDK examples;
- official website docs and one-line installer;
- OSS export guard, docs checks, example checks, and release audit scripts.
- ACC operation timeouts are preserved from 1 to 600000 milliseconds and rejected when out of range; audit write failures emit redacted structured events with a process-local `/health` counter; model credential source conflicts are diagnosed while traces record only the non-secret `config` or `db` source.

Production deployments still need environment-specific domain, TLS, backups, monitoring, secret management, credential rotation, and approval workflow integration.
