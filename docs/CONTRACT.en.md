# HTTP Contract

> Current contract: `bailing.contract.v2.14`. This is the only network boundary between a business system and BailingHub.

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

### Anonymous preview identity boundary

The standalone preview link from the Chat Entries console is always anonymous.
It carries no business ticket, does not inherit a BailingHub administrator
session, and has no business-login surface of its own. Without a trusted acting
subject, every tool declared with `subject.required: true` remains hidden,
including read-only business queries. Administrators validate the built-in demo
through the Getting Started smoke action. A real embedded page must obtain a
short-lived visitor ticket from its own authenticated business backend. A
BailingHub administrator identity must never be promoted to a business acting
subject.

The public entry configuration includes optional appearance settings. The
`default_open` flag defaults to `false`; when it is `true`, the official widget
opens its panel after loading. Existing embeds with `data-open="1"` also keep
forcing the panel open, independently of this entry setting. Because the
widget fetches entry configuration on every page load, changing this option in
the console does not require changing host-page markup.

Each Origin allowlist item must be an HTTP(S) `scheme://host[:port]` value.
Chat-entry saves canonicalize and deduplicate origins and reject paths, query
strings, user information, and fragments. When a browser sends an Origin that
is not allowlisted, public chat endpoints return 403 before starting a job. An
empty list remains unrestricted, and requests without a browser Origin remain
compatible with mini-program and server-side callers. The Origin allowlist is
therefore a browser anti-embedding boundary, not server-side authentication.

The embedded widget creates a job with `POST /chat/{entry_key}` and consumes its result through:

```http
GET /chat/{entry_key}/events/{job_id}
Accept: text/event-stream
```

The base event set is `open`, `status`, `ping`, `done`, `failed`, and `timeout`. When incremental model output is available, the stream also emits `phase`, `reset`, and `delta` events under protocol `bailing.chat.stream.v1`.

Incremental text is provisional transport data. It is not a durable conversation message, callback payload, or audit record. Clients must replace provisional output with the canonical `done` payload, which is rebuilt from the final job record. Event IDs are monotonic per job and support `Last-Event-ID` replay. A `reset` event instructs the client to discard provisional text before continuing.

See [STREAMING.en.md](STREAMING.en.md) for event payloads, reconnect rules, provider fallback, audit boundaries, and multi-replica deployment requirements.

### Non-blocking `bailing-form` responses

`POST /chat/{entry_key}` accepts exactly one user input shape: a normal non-empty
`message`, or an `interaction_response` to a form rendered by an earlier final
reply. Both shapes keep the existing optional `visitor_id`, `ticket`,
`thread_id`, `context`, and `client_capabilities` fields.

```json
{
  "visitor_id": "visitor_01HXYZ",
  "thread_id": "support_1",
  "interaction_response": {
    "type": "bailing-form",
    "version": 1,
    "source_job_id": "job_that_rendered_the_form",
    "form_id": "refund_info",
    "submission_id": "01JFORMRESPONSE0001",
    "action": "submit",
    "values": {
      "reason": "The item arrived damaged",
      "method": "original"
    }
  }
}
```

The source job has already reached `done`. Submitting or cancelling the form
creates a new user turn and a new job in the same thread; it does not pause or
resume the source job and adds no `input_required` or SSE status. `action` is
`submit` or `cancel`; submit requires a values object, while cancel cannot carry
non-empty values.

The server reloads the immutable final reply from `source_job_id` and validates
that the source job is done and belongs to the same entry, verified uid or
anonymous visitor, and thread. Values are validated against the matching source
form declaration, never against a client-supplied schema. A stable
`submission_id` matches `[A-Za-z0-9_-]{8,64}`. It makes retries for the same
source job and form return the original job, optionally with `deduped:true`,
instead of running twice, and must not be reused for different values. The
serialized `values` object is capped at 32 KiB.

After validation, the server builds a self-contained user message from the
original field labels and choices. Values are therefore durable conversation
ledger content. Job metadata and the optional history `interaction` summary
retain only `type`, `version`, `source_job_id`, `form_id`, `submission_id`, and
`action`, without duplicating values. Form data remains untrusted user data and
cannot change identity, routing, tool allowlists, approval, or final business
authorization. A form must not request passwords, API keys, tokens, private
keys, or payment credentials, and it is not a substitute for the governed tool
approval path.

If the canonical user message would exceed 4,000 characters, the server returns
400 instead of silently truncating form values. Keep the same `submission_id`,
shorten the entered content, and retry.

### Optional Widget Renderers

Charts and forms do not add a new server-side attachment type or change the
canonical `reply` payload. Both consume declarative fenced payloads. A host page
may register a trusted chart renderer through
`window.BailingChat.registerRenderer(...)`; the official widget provides the
constrained `bailing-form` and posts its response through the contract above.
Unknown types, invalid JSON, oversized payloads, or renderer failures fall back
to a text code block. See [WIDGET_RENDERERS.en.md](WIDGET_RENDERERS.en.md) for
the full trust and lifecycle contract.

## Tool Provider Spec

Recommended location:

```text
/.well-known/bailing/tools.json
```

For URL-backed providers, declare the expected access posture with
`spec_access_policy`:

- `signed_required` is the default and recommended policy;
- `public_allowed` is an explicit decision to let anyone who can reach the URL
  read the capability catalog; it never relaxes tool-call signatures or
  business authorization.

These are the only configurable policy values. The read-only migration state
for providers created before this contract is not part of the public
configuration surface; see
[COMPATIBILITY.en.md](COMPATIBILITY.en.md#url-tool-catalog-access-policy-upgrade).

For `signed_required`, a URL refresh reads with a correct signature and then
checks unsigned and invalid-signature requests. It updates the cache only when
the signed request succeeds and both negative requests return 401/403/404;
public or inconclusive evidence fails the refresh and preserves the old cache.
`public_allowed` uses only an unsigned primary request and records `public` on
success; if the endpoint is actually protected, it records `inconclusive` and
fails instead of silently retrying with a signature. The console displays
expected policy and observed status separately.
A signed-only spec response must include
`Cache-Control: private, no-store` so an intermediary cannot replay one valid
response as a public cached document. PHP/PHP7 `SpecServer::respond()` adds this
header when a secret is supplied; framework integrations can apply
`SpecServer::responseHeaders($secret)`. Deliberately public PHP endpoints should
use `handlePublic()` or `respondPublic()` instead of hiding the decision in a
`null` secret.

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
X-Bailing-Tool-Scope: order.read
X-Bailing-Job-Id: job_...
X-Bailing-On-Behalf-Of: u_42
X-Bailing-Idempotency-Key: <stable side-effect key>
```

The signature binds:

- timestamp
- HTTP method
- path with query
- body hash
- on-behalf-of subject
- job id

Business systems must verify the signature and then run their own authorization logic.

For non-read-only, non-idempotent tools, the idempotency key is stable for the job, subject, tool, and canonical arguments. The business system should use it, or a stronger domain key, to deduplicate side effects. BailingHub persists an execution journal before dispatch; if that journal is unavailable, the side-effecting request is not sent. It does not automatically replay an uncertain outcome after a timeout, disconnect, audit failure, or restart. Recovery checks unresolved journal entries before invoking the model. Such a call terminates with `governance_state=reconciliation_required` and `auto_retry_allowed=false`.

This is fail-closed behavior, not an exactly-once guarantee. A request that never reached the business system can still be frozen, so operators must reconcile the journal against business-side records. The idempotency key does not replace signature verification or business authorization.

The built-in `send_message` capability is treated as a side effect as well. It uses the same durable journal. Partial delivery, including a successful text chunk followed by a failed attachment or card, is frozen as potentially committed and is not replayed automatically. When a channel has no native idempotency contract, reconciliation must use the job, recipient, canonical message arguments, and channel-side records.

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
