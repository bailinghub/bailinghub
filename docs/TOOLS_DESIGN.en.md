# Tool Governance Design

Tool governance is the core runtime value of BailingHub. It lets agents call business tools without bypassing business-side permissions, audit, approval, or rate limits.

## Governance Layers

| Layer | Purpose |
|---|---|
| Route allowlist | The route decides which tool scopes are visible to the agent. |
| Risk level | Tools declare runtime risk such as low, medium, or high. |
| Rate limit | Tool provider and tool-level limits protect business systems. |
| Approval intent | High-risk or confirmation-required calls are frozen for approval. |
| Signature | Tool calls are signed by the hub and verified by the business system. |
| Business authorization | The business backend checks the on-behalf-of subject against its own permissions. |
| Audit and trace | Every important decision and call is recorded. |

## URL Spec Access Posture

A URL-backed provider stores two different kinds of state:

- `spec_access_policy` is the operator's expectation: `signed_required`
  (default) or `public_allowed`. These are the only configurable values;
- `spec_access_probe` is refresh-time evidence with status `protected`,
  `public`, or `inconclusive`, plus whichever signed, unsigned, and
  invalid-signature HTTP observations apply to that policy.

The console must display expectation and evidence separately. Read-only state
for providers created before the policy existed is documented only in
[COMPATIBILITY.en.md](COMPATIBILITY.en.md#url-tool-catalog-access-policy-upgrade)
and is not a third Schema, API, or console choice. Choosing `public_allowed`
requires a clear warning because paths,
parameters, scopes, and risk metadata become readable to anyone who can reach
the URL. This choice does not weaken tool-call verification or business-side
authorization.

Protected spec responses send `Cache-Control: private, no-store`. PHP/PHP7
`SpecServer::respond()` adds it when a secret is present, and framework
integrations can use `SpecServer::responseHeaders($secret)`. Explicitly public
endpoints use `handlePublic()` / `respondPublic()`; the older null-secret form
remains wire-compatible but is no longer the recommended spelling.

For `signed_required`, a refresh may replace the cache only when the correctly
signed request succeeds and both unsigned and invalid-signature probes return
401/403/404. Public or inconclusive observations fail the refresh and preserve
the previous cache. `public_allowed` uses an unsigned primary request and never
falls back to a signed fetch when the endpoint is actually protected.

## Multiple Tool Providers Per Route

A route may combine capabilities from several business systems without weakening provider boundaries:

```json
{
  "sources": [
    { "provider": "orders", "allow": ["order.*"], "subject_field": "operator_uid" },
    { "provider": "shipping", "allow": ["shipment.read"] }
  ],
  "max_calls": 8
}
```

Each source keeps its own scope allowlist, subject mapping, signature secret, rate limits, approval records, and audit identity. The runtime presents one combined tool surface to the Agent, but dispatches every call back through the governance chain of its owning provider. Operation IDs must be unique across all sources attached to the same route; a collision is rejected before execution.

`max_calls` is a route-wide budget shared by all sources and configured independently per route. It prevents an Agent from multiplying the call budget simply by crossing provider boundaries. After each business-tool round, the runtime supplies trusted used and remaining counts; it guides the model to converge with one call left and removes all tools at exhaustion so the model must form a final answer.

Internal DSML-like tool-protocol markup in a final answer is intercepted, never displayed or parsed for execution, and receives at most one tool-free safe rewrite. A repeated violation fails closed. Streaming clients must discard provisional text when they receive `reset.reason=protocol_violation`.

## Risk Levels

| Risk | Typical use |
|---|---|
| `low` | Read-only query or deterministic preview. |
| `medium` | Create draft, submit request, or start a business workflow. |
| `high` | Immediate sensitive side effect such as refund execution, staff deletion, permission change, or batch outbound action. |

Risk level is guidance for the hub runtime. It does not replace business authorization.

## Approval Intent

The hub should not assume the approver is a hub administrator. In many real systems, the approver is a manager, finance operator, tenant admin, or business-side role.

The hub records the approval intent and frozen argument snapshot. The business system should usually own the approval UI and final decision.

## Signature Contract

Tool calls carry:

- `X-Bailing-Signature`;
- `X-Bailing-Timestamp`;
- `X-Bailing-Tool-Scope`;
- `X-Bailing-Job-Id`;
- `X-Bailing-On-Behalf-Of`;
- `X-Bailing-Idempotency-Key` for side-effecting calls.

The business system must verify the signature and timestamp before applying its own permission checks.

## Side-Effect Execution Journal

For a non-read-only, non-idempotent business tool, BailingHub persists a `dispatching` journal entry before sending the request. It records `response_recorded` after receiving an HTTP response and moves the entry to `completed` only after the result audit and terminal ledger update succeed.

If the durable execution journal is unavailable, BailingHub rejects a side-effecting tool before dispatch. It never falls back to sending first and recording only after success.

If a timeout, network interruption, process restart, result-audit failure, or terminal-ledger failure leaves the outcome uncertain, the journal remains in `dispatching`, `uncertain`, `response_recorded`, or `evidence_degraded`. Recovery checks unresolved journal entries before invoking the model, so protection does not depend on the model selecting the same tool again. A recovered runtime does not send the business request again. It returns:

```json
{
  "governance_state": "reconciliation_required",
  "auto_retry_allowed": false
}
```

This is deliberately not an exactly-once claim. Fail-closed behavior can freeze a request that never reached the business system. Operators must reconcile the durable job, subject, tool, canonical argument hash, and `X-Bailing-Idempotency-Key` against business-side records.

The business system should deduplicate side effects using `X-Bailing-Idempotency-Key` as defense in depth. The key is stable for the job, subject, tool, and canonical arguments. It does not replace signature verification, business authorization, or domain-specific idempotency rules.

The built-in `send_message` capability uses the same journal and recovery boundary. If any text chunk, card, or attachment may already have been delivered, a later failure is treated as an uncertain external effect. The runtime freezes the send for reconciliation instead of replaying the whole message.

## Multimodal Input Layer

Uploaded images, audio, video, and files are treated as untrusted input. They do not grant tool authority and must not be interpreted as approval evidence.

Audio handling is an explicit route policy:

- `transcribe` uses a dedicated speech model and sends only the resulting text to the main model;
- `inline` forwards audio only when the operator explicitly configures a main model that supports it;
- `off` rejects audio with deterministic user guidance.

Missing audio configuration defaults to `off`. If `transcribe` is selected but its credential, model, or endpoint cannot be resolved, the runtime fails closed. It does not forward the audio to the main model, infer content from file metadata, or silently switch protocols.

Dedicated speech models may use either the OpenAI-compatible `/audio/transcriptions` multipart protocol or the `/chat/completions` Data URL `input_audio` protocol. The selected protocol is part of route configuration and audit metadata.

Speech audit events may record the selected mode, protocol, model, MIME type, byte count, and outcome. They must not retain the audio body, Data URL, credential, or complete provider request.

## Parameter-Level Confirmation

Some tools are safe for small values but risky for large values. Use parameter-level confirmation rules for thresholds such as:

- amount;
- affected count;
- cross-tenant access;
- sensitive field access;
- external message delivery.
