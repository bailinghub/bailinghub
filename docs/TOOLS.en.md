# Business Tools

BailingHub lets an existing business system expose selected APIs to AI agents as governed tools.

The goal is not to give the agent direct database access. The goal is to let the agent call the same business actions that a real user could perform, while keeping signatures, permission checks, approvals, audit trails, and traceability in place.

## Core Principle

```text
BailingHub controls reach.
Your business system controls authority.
```

The hub decides which tools the agent can see and call. Your backend still decides whether the current user can actually perform the action.

## How Tool Providers Work

A tool provider is a business API catalog.

Common input forms:

- OpenAPI with `x-agent-capability` extensions
- PHP 8 annotations
- PHP 7 builder SDK
- Node SDK
- Python SDK
- future MCP adapters

Recommended path:

```text
/.well-known/bailing/tools.json
```

The hub imports the spec, validates it, and compiles it into internal `ToolDefinition` records.

Attach one or more providers to a route through `tools.sources[]`:

```json
{
  "sources": [
    { "provider": "order-tools", "allow": ["order.*"] },
    { "provider": "shipping-tools", "allow": ["shipment.read"] }
  ],
  "max_calls": 6
}
```

The allowlist is evaluated per provider. Provider credentials and business identities are not merged; only the Agent-facing tool catalog is composed. Tool names must therefore be unique within the route.

## Minimal Tool

```js
import { buildOpenApiSpec, param, tool } from '@bailinghub/connect';

export default buildOpenApiSpec({
  title: 'Order Tools',
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

## Tool Shapes

Do not expose every CRUD endpoint blindly. Start with AI-friendly business actions:

| Shape | Example | Typical governance |
|---|---|---|
| Query | `order.get`, `staff.search` | `low`, read-only |
| Preview | `refund.preview`, `staff_remove.impact` | `low` or `medium` |
| Request/draft | `refund.request.create` | `medium`, business workflow handles approval |
| Execute | `refund.execute`, `staff.delete` | `high` or approval required |
| Batch execute | `coupon.batch_send`, `price.batch_update` | `high`, parameter-level confirmation |

## Risk and Approval

Use `risk` / `x-agent-capability.risk.level` to describe how the hub should treat AI-triggered calls:

- `low`: normally safe, usually read-only
- `medium`: allowed with audit trail, often creates workflow records or drafts
- `high`: requires explicit approval before execution

Use parameter-level confirmation when only some calls are risky:

```js
tool({
  name: 'refund_execute',
  method: 'POST',
  path: '/api/refunds/execute',
  description: 'Execute refund',
  scope: 'refund.execute',
  risk: 'medium',
  requiresSubject: true,
  confirmWhen: [
    { param: 'amount', op: '>', value: 500, label: 'Refunds above 500 require human confirmation' }
  ],
  params: [
    param('order_id', { required: true, description: 'Order ID' }),
    param('amount', { type: 'number', required: true, description: 'Refund amount' })
  ],
});
```

## Signed Tool Calls

The hub calls your business API with HMAC signature headers:

```text
X-Bailing-Signature: sha256=<hmac>
X-Bailing-Timestamp: 1782912000
X-Bailing-Tool: order_get
X-Bailing-Job-Id: job_...
X-Bailing-On-Behalf-Of: u_42
```

Your backend must:

1. verify the signature
2. verify the timestamp window
3. read `X-Bailing-On-Behalf-Of`
4. check your own permission table
5. execute only if the user is allowed

Never treat a valid signature as business authorization.

## Recommended Response Shape

For workflow-like tools, return clear status:

```json
{
  "ok": true,
  "status": "pending_approval",
  "message": "Refund request created and waiting for manager approval.",
  "business_id": "refund_req_1001",
  "url": "https://business.example.com/refunds/refund_req_1001"
}
```

This helps the agent explain whether an action was executed, submitted, drafted, or rejected.

## Industry Templates

E-commerce:

- `order.get`
- `refund.preview`
- `refund.request.create`
- `refund.execute`

HR/OA:

- `staff.search`
- `staff_remove.impact`
- `staff_remove.request.create`
- `staff.delete`

CRM:

- `customer.search`
- `followup.create`
- `deal.stage.update`

Operations:

- `service.health`
- `deploy.preview`
- `deploy.request.create`
- `deploy.execute`

Finance:

- `invoice.query`
- `payment.request.create`
- `payment.execute`
