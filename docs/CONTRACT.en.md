# HTTP Contract

> Current contract: `bailing.contract.v2.13`. This is the only network boundary between a business system and BailingHub.

This document summarizes the public wire contract between a business system and BailingHub.

The detailed Chinese contract remains the most complete reference: [CONTRACT.md](CONTRACT.md).

## Trigger a Job

```http
POST /run
Authorization: Bearer <client-token>
Content-Type: application/json
```

```json
{
  "request_id": "order-10001-ai-001",
  "route": "order_assistant",
  "input": "Help me analyze why this order has not shipped",
  "metadata": {
    "tenant_id": "t_100",
    "operator_uid": "u_42",
    "order_id": "SO20260701001"
  },
  "callback": "https://biz.example.com/ai/callback"
}
```

Response:

```json
{
  "job_id": "job_...",
  "status": "queued"
}
```

`request_id` is the business-side idempotency key.

## Query a Job

```http
GET /jobs/{job_id}
Authorization: Bearer <client-token>
```

```json
{
  "id": "job_...",
  "status": "queued | running | done | error",
  "result": {
    "summary": "...",
    "detail": {}
  },
  "error": null
}
```

## Callback

If a callback URL is configured, the hub sends signed result payloads.

```http
POST <business-callback-url>
X-Bailing-Signature: sha256=<hmac>
X-Bailing-Timestamp: 1782912000
Content-Type: application/json
```

```json
{
  "job_id": "job_...",
  "route": "order_assistant",
  "status": "done",
  "result": {
    "summary": "..."
  }
}
```

The business system must verify the callback signature before consuming the payload.

## Embedded Chat Streaming

The embedded widget creates a job with `POST /chat/{entry_key}` and consumes its result through:

```http
GET /chat/{entry_key}/events/{job_id}
Accept: text/event-stream
```

The base event set is `open`, `status`, `ping`, `done`, `failed`, and `timeout`. When incremental model output is available, the stream also emits `phase`, `reset`, and `delta` events under protocol `bailing.chat.stream.v1`.

Incremental text is provisional transport data. It is not a durable conversation message, callback payload, or audit record. Clients must replace provisional output with the canonical `done` payload, which is rebuilt from the final job record. Event IDs are monotonic per job and support `Last-Event-ID` replay. A `reset` event instructs the client to discard provisional text before continuing.

See [STREAMING.en.md](STREAMING.en.md) for event payloads, reconnect rules, provider fallback, audit boundaries, and multi-replica deployment requirements.

## Tool Provider Spec

Recommended location:

```text
/.well-known/bailing/tools.json
```

Minimal OpenAPI shape:

```json
{
  "openapi": "3.0.0",
  "info": { "title": "Order Tools", "version": "1.0.0" },
  "paths": {
    "/api/orders/{id}": {
      "get": {
        "operationId": "order_get",
        "summary": "Query order detail",
        "x-agent-capability": {
          "version": 1,
          "enabled": true,
          "scope": "order.read",
          "subject": { "required": true }
        },
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": { "type": "string", "description": "Order ID" }
          }
        ]
      }
    }
  }
}
```

Important `x-agent-capability` fields:

| Field | Meaning |
|---|---|
| `version` / `enabled` / `scope` | Contract version, exposure switch, and route allowlist scope. |
| `risk.level` | `low`, `medium`, or `high`. |
| `approval.required` | Always require approval before execution. |
| `approval.when` | Require approval only when parameter rules match. A rule must target a typed parameter declared in the standard schema. Comparisons preserve JSON types: strings are never coerced into numbers or booleans, and a type mismatch is rejected before the business request is sent. |
| `subject.required` | Hide the tool if there is no trusted on-behalf-of subject. |
| `audit.sensitive` | Redact sensitive parameter values from audit logs. |
| `execution.readonly` | Mark POST-based query endpoints as semantically read-only. |
| `execution.idempotent` | Mark non-GET endpoints as safe to retry. |
| `execution.timeout_ms` | Override the provider timeout for this operation with an integer from 1 to 600000 milliseconds. |

## Tool Call Signature

BailingHub calls business tools with signed headers:

```http
X-Bailing-Signature: sha256=<hmac>
X-Bailing-Timestamp: 1782912000
X-Bailing-Tool: order_get
X-Bailing-Job-Id: job_...
X-Bailing-On-Behalf-Of: u_42
```

The signature binds:

- timestamp
- HTTP method
- path with query
- body hash
- on-behalf-of subject
- job id

Business systems must verify the signature and then run their own authorization logic.

## Approval Decision

High-risk or confirmation-required tool calls can be frozen as approval intents.

The business side can later send a decision:

```json
{
  "approval_id": "appr_...",
  "job_id": "job_...",
  "request_id": "tool_call_...",
  "args_hash": "sha256:...",
  "decision_id": "biz_decision_1001",
  "decision": "approved",
  "approver": {
    "id": "u_manager",
    "name": "Manager"
  },
  "comment": "Approved by manager"
}
```

The hub verifies that the decision matches the frozen call snapshot before allowing the task to continue.

## Security Baseline

- Treat all user input as untrusted data.
- Use production secrets only through environment variables or secret managers.
- Give each business system its own client token.
- Use route allowlists for tools.
- Verify HMAC signatures on tool calls and callbacks.
- Never treat a valid signature as business authorization.
- Keep audit retention aligned with your compliance requirements.
