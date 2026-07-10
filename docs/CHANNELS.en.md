# Inbound Channels

Inbound channels let external messaging platforms send messages into BailingHub. A channel maps platform callbacks to hub routes without hard-coding the platform into business logic.

## Channel Model

| Field | Purpose |
|---|---|
| `kind` | Adapter type, such as a collaboration platform or custom webhook adapter. |
| `route_key` | Route used for messages received through this channel. |
| `config` | Adapter-specific settings. |
| `client_id` | Optional client boundary for authentication, budgets, and allowlists. |

## Runtime Path

```text
platform callback
  -> channel adapter verifies platform signature
  -> normalize sender and message
  -> resolve route
  -> create or continue conversation
  -> dispatch job
  -> reply through platform-specific delivery rules
```

## Adapter Rules

- Platform verification should happen before creating hub jobs.
- Channel-specific sender IDs should be normalized into principals or visitor identities.
- Long-running tasks should use asynchronous delivery if the platform has a short response window.
- Channel adapters should not bypass route allowlists, tool governance, or audit records.

## Current Scope

The framework contains concrete adapter work for enterprise messaging scenarios, but the public contract is channel-agnostic. Additional platforms should be implemented as adapters that preserve the same route and principal model.
