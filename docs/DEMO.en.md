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
