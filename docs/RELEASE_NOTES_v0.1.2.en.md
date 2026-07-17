# v0.1.2 Release Notes

BailingHub `v0.1.2` is a security hardening patch for the server root token and credentials derived from it. It adds no database migration and does not change the public HTTP, SDK, or signature formats.

## What Changed

- Task-scoped `tool_token` values no longer use the literal `bailing` as an HMAC fallback. Issuance fails closed without a configured root token.
- Job callback and alert webhook signatures no longer use a fixed fallback secret.
- Tokenless development remains available only for `development` mode bound to `127.0.0.1`, `localhost`, or `::1`.
- Production and non-loopback listeners reject missing tokens, values shorter than 24 characters, and known public placeholders.
- `docker-compose.yml` and `docker-compose.images.yml` no longer ship a predictable machine-admin token.
- The tokenless development-admin fallback is restricted to loopback mode, and the security scanner now guards these rules.

## Before Upgrading

Production, server, or LAN deployments must set a strong random token first:

```bash
export BAILING_TOKEN="$(openssl rand -hex 32)"
```

Persist that same value in the deployment `.env`, orchestrator secret, or secret manager. Do not generate a new value on every restart. Deployments created by the official one-line installer already have a generated and persisted random token.

## Compatibility

- Database migration: none.
- Public HTTP and SDK contracts: unchanged.
- HMAC wire format: unchanged.
- Loopback development: remains zero-config.
- Production or non-loopback deployments: must provide a token that meets the new baseline.

## Validation

```bash
npm run typecheck
npm test
npm run security:scan
npm run release:check
```
