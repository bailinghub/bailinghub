# Vision

BailingHub is an AI control plane for traditional business systems. It lets existing systems expose selected business actions to agents while keeping identity, authorization, risk controls, audit trails, delivery, and operational ownership inside the operator's boundary.

## Current Focus

The open-source edition focuses on a reliable self-hosted control plane for one organization:

- stable HTTP contracts for triggers, chat entry, channels, tool calls, and delivery;
- configurable routing from business scenarios to targets, knowledge, memory, tools, and delivery;
- tool governance with allowlists, risk levels, rate limits, approvals, signatures, and audit;
- Docker demo, SDKs, schema validation, and clear operating docs;
- clean extension seams for channels, targets, storage, tool providers, and business adapters.

## Core Boundary

Core stays small. The core defines contracts, runtime primitives, governance models, state interfaces, and scheduling semantics. Concrete integrations live in adapters, SDKs, deployment templates, or external packages.

New integrations should not add private business assumptions to core. If a capability is only meaningful for one channel, model provider, storage backend, or industry workflow, it belongs outside core unless it introduces a reusable contract.

## Non-Goals For The Initial Open-Source Line

- Not a hosted multi-tenant SaaS platform.
- Not a general workflow builder.
- Not a marketplace for third-party plugins.
- Not a replacement for business-side authorization.
- Not a promise that every adapter is maintained at the same maturity level as core.

These may evolve later, but they should not make the self-hosted control plane harder to understand or operate.

## Extension Policy

Adapters and plugins are welcome when they preserve the control-plane contract:

- business authority remains business-side;
- secrets are supplied by environment or operator-managed secret stores;
- tool execution stays signed, audited, and rate-limited;
- failure modes are explicit and fail closed for risky actions;
- configuration is schema-backed and documented.

Marketplace-style distribution is intentionally deferred until provenance, signing, sandboxing, review, and vulnerability response are designed. The project should not make untrusted code installation look casual.
