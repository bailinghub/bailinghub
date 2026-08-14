# Docker Demo

The Docker demo is the fastest way to understand BailingHub end to end.

It starts:

- `bailinghub`: the hub service and console
- `mysql`: hub state database
- `bailing-demo-business`: a demo business system
- a demo route
- a demo integration client
- a demo OpenAPI tool provider
- audit and trace data

## Start

```bash
export BAILING_TOKEN="${BAILING_TOKEN:-$(openssl rand -hex 32)}"
docker compose up --build
```

Keep the same `BAILING_TOKEN` for subsequent Compose commands, or save it in a local `.env` file. The one-line installer generates a random value automatically.

Open:

```text
http://localhost:18900/console/
```

Login:

```text
admin / bailing-demo-admin
```

## Console Import And The Stateless Read-Only Profile

Core also provides a managed demo dataset that administrators can import from the onboarding prompt or setup page. It creates deterministic targets, tool providers, routes, and clients, but it does not fabricate jobs, approvals, costs, or audit history. A smoke run generates the runtime records through the real execution path.

The deployment supplies the demo endpoint and profile:

```bash
DEMO_BUSINESS_URL=http://127.0.0.1:19080
DEMO_TOOL_SECRET=<independent-random-secret>
DEMO_PROFILE=stateless-readonly
```

- `full-local` is the complete Docker demo with order lookup, ticket creation, refund approval, and failure tools.
- `stateless-readonly` is for shared or embedded evaluation environments. Demo Business must bind to loopback, exposes only order lookup and failure observation, stores no request state, uses no Hub callback, and creates no public chat entry.

Business tools in both profiles require the trusted demo subject. After import,
run smoke from Getting Started so the server supplies that fixed demo subject
and creates a real job and trace. A standalone chat preview does not inherit the
BailingHub administrator identity; manually binding an entry to the demo route
does not unlock those tools for an anonymous visitor.

Core records the exact objects it owns, together with their fingerprints, in the durable `bz_demo_datasets` manifest. Refresh and clear fail with `409` if a name is already occupied, a managed object changed, or another configuration references it. Clearing removes only unchanged, unreferenced demo configuration; jobs, messages, traces, and audit history remain intact.

The Admin API is:

- `GET /admin/api/demo-dataset/status`
- `POST /admin/api/demo-dataset/import`
- `DELETE /admin/api/demo-dataset`

Import and clear require all of `targets:write`, `tools:write`, `routes:write`, and `clients:write`. Status requires `audit:read` or the same aggregate write permissions.

## Smoke Test

```bash
docker compose exec bailinghub npm run smoke
```

This checks health, console endpoints, schema loading, route readiness, and demo runtime paths.

## End-to-End Demo

```bash
docker compose exec bailinghub npm run demo:e2e
```

The demo flow covers:

1. a business request entering the hub
2. route selection
3. context assembly
4. model/tool execution
5. signed business tool call
6. trace and audit records
7. job result inspection

## Demo Tool Provider

The demo business app exposes:

```text
/.well-known/bailing/tools.json
```

The hub imports this OpenAPI spec and compiles selected operations into governed tools.

The key point is not the demo business domain. The important contract is:

```text
business API -> OpenAPI/SDK tool spec -> hub governance -> signed tool call -> business authorization
```

## Production Difference

The demo is intentionally simple. Before production:

- set `BAILING_ENV=production`
- move all secrets to environment variables or a secret manager
- use MySQL
- create a real admin account
- create a real integration client
- configure real model credentials
- expose only selected business tools
- verify every tool call signature
- check your own business permission table after signature verification

See [QUICKSTART.en.md](QUICKSTART.en.md) for the full setup path.
