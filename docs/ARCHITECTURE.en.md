# Architecture

BailingHub is a self-hosted AI control plane for existing business systems. It is deployed as a separate service and communicates with business systems through stable network contracts. Business systems trigger jobs, expose selected tools, verify signed callbacks, and keep final authority over permissions.

The hub owns routing, context assembly, tool governance, approvals, audit trails, traceability, delivery, and runtime state. It does not import business code and does not require direct access to the business database.

## Layer Model

| Layer | Responsibility |
|---|---|
| Entry layer | `/run`, web widget, inbound channels, console APIs, executor APIs, and public assets. |
| Identity layer | Normalize caller, client, channel, visitor, and on-behalf-of principal into one runtime subject model. |
| Routing layer | Map a business scenario to target, model credential, knowledge, memory, tools, budget, and delivery. |
| Context layer | Assemble messages, summaries, knowledge retrieval, page context, and task metadata before dispatch. |
| Brain layer | Dispatch to an in-hub OpenAI-compatible model target or an external executor adapter. |
| Tool governance layer | Enforce route allowlists, scopes, risk levels, rate limits, approvals, audit, signatures, and authorization probes. |
| Delivery layer | Return results through polling, callbacks, inbound channel replies, or delivery adapters with retry and trace records. |

## Runtime Path

```text
business trigger / widget / inbound channel
  -> authenticate client or channel
  -> resolve route
  -> normalize principal and audience
  -> assemble context
  -> dispatch target
  -> expose governed business tools
  -> sign tool calls
  -> business system verifies signature and authorizes the subject
  -> record trace, audit, delivery, and result
```

## Core Boundary

Core code should define reusable contracts, configuration models, runtime primitives, state interfaces, scheduling semantics, and target abstractions. Concrete integrations belong in adapters, SDKs, examples, or external packages.

The core must not contain private deployment assumptions, hard-coded business channels, provider-specific secrets, or industry-specific workflows.

## Deployment Scope

The open-source edition is designed for one organization per deployment. One hub can connect multiple business systems, clients, routes, and tool providers, but they share one management and audit boundary.

If multiple isolated organizations need to use BailingHub, run separate hub deployments. `client`, `route`, and `tool_provider` records are not organization-level isolation boundaries.

## State Ownership

The hub owns its own state database with `bz_` tables. Jobs, messages, approvals, audit records, trace events, rate-limit ledgers, delivery dead letters, and configuration snapshots live there. Business data remains in the business system.

The mental model is:

```text
The business system owns business truth.
The hub owns AI runtime truth.
The model session is a rebuildable cache.
```

## Tool Governance

Tools can come from OpenAPI specs, SDK-generated specs, overlays, or future adapters. The hub compiles them into a unified `ToolDefinition`, then applies:

- route allowlists;
- risk levels and confirmation rules;
- centralized rate limits;
- approval intent;
- audit and trace records;
- HMAC signatures;
- on-behalf-of subject propagation.

The business system still decides whether the subject can perform the action.

## Extension Points

- Channel adapters for inbound platforms.
- Target adapters for models and executors.
- Tool provider adapters for OpenAPI, SDKs, and future protocols.
- Storage adapters for object storage.
- Knowledge connectors and indexing services.
- Delivery adapters for callbacks and channel-specific result delivery.

New adapters should preserve the same identity, tool, audit, and delivery contracts.
