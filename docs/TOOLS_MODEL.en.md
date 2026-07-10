# ACC Tool Model

[ACC (Agent Capability Contract)](https://www.agentcapability.org) is the public declaration contract for exposing business capabilities to agents. Its independent specification repository is [agent-capability/agent-capability-contract](https://github.com/agent-capability/agent-capability-contract). BailingHub adopts the ACC contract model and normalizes OpenAPI `x-agent-capability`, SDK-generated specs, overlays, MCP adapters, and future sources into a unified `ToolDefinition`.

The goal is to let routes govern tools consistently regardless of where the tool declaration came from.

## Why A Unified Model

Business systems expose tools in different ways. Without a unified model, every runtime path would need provider-specific logic for allowlists, risk, approvals, signatures, authorization probes, audit, and debug UI.

The unified model gives the hub one governance surface. Conditional approval rules must target typed parameters declared in the tool schema. Numeric comparisons use JSON numbers or integers only; equality and membership comparisons do not coerce strings into numbers or booleans. A type mismatch is rejected before the business request is sent, never silently treated as a non-match.

## Tool Sources

| Source | Notes |
|---|---|
| OpenAPI | Use `x-agent-capability` ACC fields to describe agent-facing governance metadata. |
| SDK | PHP, PHP 7, Node, and Python helpers can generate the same OpenAPI-compatible spec. |
| Overlay | Operators can add governance metadata without modifying the original upstream spec. |
| Future adapters | Protocols such as MCP can be projected into the same governance model later. |

## Core Fields

| Field | Meaning |
|---|---|
| `name` | Stable tool identifier exposed to the model. |
| `scope` | Permission and route allowlist unit. |
| `description` | Human and model-readable description. |
| `method` / `path` | Business HTTP endpoint shape. |
| `params` | Structured parameter schema. |
| `risk` | Runtime risk level. |
| `requiresSubject` | Whether an on-behalf-of principal is required. |
| `confirmRequired` | Whether every call must be approved. |
| `confirmWhen` | Parameter-level confirmation rules. |
| `sensitive` | Parameters or fields that must be redacted in audit and trace. |

## Governance Flow

```text
tool source
  -> compile into ToolDefinition
  -> route allowlist filters scopes
  -> runtime normalizes JSON arguments and validates governance-relevant approval conditions
  -> risk and confirmation rules are applied
  -> call is signed
  -> business system verifies and authorizes
  -> trace and audit records are written
```

## Design Rule

Do not expose raw backend CRUD by default. Design agent-facing tools as business actions: query, preview, create request, create draft, execute with confirmation.
