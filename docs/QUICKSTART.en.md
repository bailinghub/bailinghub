# Quickstart

This guide gets you from a fresh checkout to the first working BailingHub hub.

BailingHub is designed around one idea:

> Your business system triggers work. The hub routes, assembles context, governs tools, records audit trails, and sends results back.

## Mental Model

```text
Business system --POST /run--> BailingHub route --> model / executor --> result delivery
                                      |
                                      +-- knowledge
                                      +-- memory
                                      +-- OpenAPI/SDK tools
                                      +-- approval and audit
```

Key objects:

| Object | Meaning |
|---|---|
| Route | A business scenario. It chooses the model/executor, memory policy, knowledge, tools, retry, and delivery behavior. |
| Client | A business system credential with route allowlists and rate limits. |
| Target | A model or executor slot. Start with the built-in `llm` target. |
| Tool provider | A business system's agent-callable API catalog, usually OpenAPI with ACC `x-agent-capability` metadata or an SDK-generated spec. |
| Runtime ledger | Jobs, messages, audit records, approvals, and trace events stored by the hub. |

## Option A: Docker Demo

```bash
export BAILING_TOKEN="${BAILING_TOKEN:-$(openssl rand -hex 32)}"
docker compose up --build
```

Keep the same `BAILING_TOKEN` for later `docker compose` commands, or save it in a local `.env` file. Only loopback-bound development mode may run without a token. Production and non-loopback listeners reject missing, short, or known placeholder values.

Open:

```text
http://localhost:18900/console/
```

Login:

```text
admin / bailing-demo-admin
```

The demo creates:

- hub service
- MySQL
- demo business app
- `demo_support` route
- `demo-business` tool provider
- `demo-app` integration client

Run smoke checks inside the container:

```bash
docker compose exec bailinghub npm run smoke
```

Run the full demo flow:

```bash
docker compose exec bailinghub npm run demo:e2e
```

## Option B: One-Line Install

For a fresh Ubuntu/Debian server:

```bash
curl -fsSL https://www.bailinghub.com/install.sh | sh
```

Use official prebuilt images:

```bash
curl -fsSL https://www.bailinghub.com/install.sh | env BAILING_INSTALL_MODE=image sh
```

Use source mode for audit or development:

```bash
curl -fsSL https://www.bailinghub.com/install.sh | env BAILING_INSTALL_MODE=source sh
```

Use the public GHCR images outside China:

```bash
curl -fsSL https://www.bailinghub.com/install.sh | env \
BAILING_INSTALL_MODE=image \
BAILING_IMAGE_REGISTRY=ghcr.io \
BAILING_IMAGE_NAMESPACE=bailinghub \
BAILING_MYSQL_IMAGE=mysql:8.4 \
sh
```

The default image registry is the Aliyun ACR mirror for networks in China. Both registries publish the same versioned BailingHub and demo application images.

## Option C: Local Development

Requirements:

- Node.js 22+
- MySQL for full runtime features

```bash
npm install
npm run doctor
npm run typecheck
npm run db:init
npm start
```

For unattended deployments, set both `BAILING_BOOTSTRAP_ADMIN_USERNAME` and
`BAILING_BOOTSTRAP_ADMIN_PASSWORD` before starting the service. BailingHub
creates that account only when the admin table is empty. Restarts, upgrades,
and container recreation with the same database never update an existing
account or password. For an explicit create or password reset, use
`npm run admin:create -- <username> [password] [role]`; the startup path never
invokes that command automatically.

Health check:

```bash
curl http://localhost:18900/health
```

## Create the First Real Integration

### 1. Create a Model Credential

In the console, open **Credentials** and add an OpenAI-compatible endpoint and API key.

The built-in `llm` target can use OpenAI-compatible providers, self-hosted model gateways, or other compatible endpoints.

### 2. Create a Route

Open **Routes** and create a business scenario.

A route controls:

- model or executor target
- system prompt
- session policy
- knowledge retrieval
- tool providers and allowed scopes
- delivery behavior
- budget and retry settings

### 3. Create a Client

Open **Clients** and create a token for your business system.

The client controls:

- which routes the business system can call
- rate limits
- budget policies
- channel restrictions

### 4. Trigger a Job

```bash
curl -X POST http://localhost:18900/run \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <client-token>' \
  -d '{
    "request_id": "demo-001",
    "route": "demo_support",
    "input": "Help me check this order",
    "metadata": {
      "operator_uid": "u_1001",
      "order_id": "SO20260701001"
    }
  }'
```

The response contains a `job_id`.

Query the result:

```bash
curl http://localhost:18900/jobs/<job_id> \
  -H 'authorization: Bearer <client-token>'
```

## Expose Business Tools

To let AI agents query or operate your system, expose a tool spec:

```text
/.well-known/bailing/tools.json
```

The preferred paths:

- PHP 8+ SDK annotations
- PHP 7 builder SDK
- Node SDK
- Python SDK
- OpenAPI with `x-agent-capability` extensions

Minimal Node example:

```js
import { buildOpenApiSpec, param, tool } from '@bailinghub/connect';

export default buildOpenApiSpec({
  title: 'Order System Tools',
  version: '1.0.0',
  authzProbe: { method: 'POST', path: '/.well-known/bailing/authz-probe' },
  tools: [
    tool({
      name: 'order_get',
      method: 'GET',
      path: '/api/orders/{id}',
      description: 'Query order detail',
      scope: 'order.read',
      requiresSubject: true,
      params: [param('id', { in: 'path', required: true, description: 'Order ID' })],
    }),
  ],
});
```

Register the tool provider in the console, then attach it to a route with an allowlist:

```json
{
  "sources": [{
    "provider": "order-tools",
    "allow": ["order.*"],
    "subject_field": "operator_uid"
  }],
  "max_calls": 5
}
```

## Security Rule

Tool authorization is two-step:

```text
BailingHub controls reach.
Your business system controls authority.
```

The hub decides which tools the agent can see and call. The business system still verifies:

- HMAC signature
- timestamp window
- `X-Bailing-On-Behalf-Of`
- its own permission table

Never treat a valid signature as business authorization.

## Before Production

Check at least:

- `BAILING_ENV=production`
- all secrets come from environment variables or a secret manager
- MySQL is used instead of local jsonl state
- each business system has its own client token
- route allowlists are minimal
- tool providers only expose selected APIs
- write tools have risk/approval policies
- business APIs verify signatures and run their own authorization
- audit retention is configured according to your compliance requirements
- admin tokens and model keys are rotated before going live

## More

- [Chinese Quickstart](QUICKSTART.md)
- [Docker Demo](DEMO.en.md)
- [Contract](CONTRACT.en.md)
- [Tool Model](TOOLS_MODEL.en.md)
- [Tool Governance](TOOLS_DESIGN.en.md)
- [AI-Friendly Tool Design](AI_FRIENDLY_TOOLS.en.md)
