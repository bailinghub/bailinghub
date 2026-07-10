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

`max_calls` is a route-wide budget shared by all sources. It prevents an Agent from multiplying the call budget simply by crossing provider boundaries.

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
- `X-Bailing-Tool`;
- `X-Bailing-Job-Id`;
- `X-Bailing-On-Behalf-Of`.

The business system must verify the signature and timestamp before applying its own permission checks.

## Parameter-Level Confirmation

Some tools are safe for small values but risky for large values. Use parameter-level confirmation rules for thresholds such as:

- amount;
- affected count;
- cross-tenant access;
- sensitive field access;
- external message delivery.
