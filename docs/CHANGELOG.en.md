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
- OpenAPI compilation now fails closed for `cookie`, unknown, or missing parameter locations instead of silently mapping them to query. ACC `timeout_ms` remains integer-only; quoted numeric strings are rejected with an actionable diagnostic.

Production deployments still need environment-specific domain, TLS, backups, monitoring, secret management, credential rotation, and approval workflow integration.
