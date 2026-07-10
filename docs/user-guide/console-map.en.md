# Console Map

## Jobs

Use Jobs as the normal operational home page. It shows conversations, runs, trace events, tool calls, approvals, model usage, errors, and delivery. It produces evidence for quality review and incident diagnosis.

## Routes

Routes define Agent scenarios. Configure target, model, context, one or more tool providers, global tool-call budget, approval delivery, retry, memory, audience, budget, and result delivery. The route row produces a stable `route_key` and generated call examples.

## Callers

Callers define which business systems may invoke which routes. Saving a caller produces an `app_id` and token. Keep tokens in backend secret storage, never in browser code.

## Targets

Targets register in-hub or executor-based brains. Most users configure these infrequently. Executor targets additionally require an executor token and a running worker.

## Model Credentials

Register model endpoints and API keys by purpose, then use Validate before assigning them to routes or knowledge bases. Model secrets stay in the hub.

## Tool Providers

Register an ACC-enabled OpenAPI JSON or YAML document, business API base URL, and signing secret. Inspect compiled tools, diagnostics, authorization probe, and semantic retrieval settings. Routes choose one or more providers and scope allowlists.

## Knowledge Bases

Create a base, select an embedding credential, ingest documents or data sources, and verify retrieval. Routes explicitly opt into one or more knowledge bases.

## Web Chat Entries

Bind a widget to a route, configure origins, appearance, welcome text, identity ticket behavior, AI disclosure, and embed code.

## Inbound Channels

Connect external messaging platforms and bind each channel to a route. Channel adapters own platform credentials and inbound/outbound message behavior.

## Media Storage

Use local storage for simple single-instance deployments. Configure object storage for multi-replica sharing, CDN delivery, lifecycle policy, or existing storage governance.

## Cost Observability

Review model tokens, estimated cost, route trends, and budget enforcement. Cost data supports optimization; it does not replace provider billing statements.

## Diagnostics

Use Diagnostics to identify invalid references, disabled dependencies, route-auto conflicts, expired leases, executor coverage, and delivery dead letters.

## System Status

Review build version, contract versions, migration state, runtime backend, and configuration health. Production readiness is also available at `/health/ready`.

## Accounts And Change Audit

Accounts control console RBAC. Change Audit records who changed configuration and when. These are administrative controls for the single organization operating the open-source instance.

