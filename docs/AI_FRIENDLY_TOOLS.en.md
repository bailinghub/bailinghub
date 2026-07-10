# AI-Friendly Tool Design

AI-friendly tools are not the same as backend CRUD APIs. They are business-facing actions designed so an agent can call them correctly, safely, and explainably.

## Minimal Mental Model

```text
Human can do it in the business UI
  -> expose a tool that performs the same business action
  -> hub signs and governs the call
  -> business system verifies the subject and permissions
```

The AI does not gain new authority. It acts on behalf of a business subject and follows the same business authorization path.

## Recommended Tool Shapes

| Shape | Examples | Notes |
|---|---|---|
| Query | `order.get`, `staff.search` | Usually `low` risk. |
| Preview | `refund.preview`, `employee_remove.impact` | Return impact before write. |
| Request | `refund.request.create`, `permission.request.create` | Usually `medium`; business workflow owns approval. |
| Draft | `campaign.draft.create`, `message.draft.create` | Agent prepares but does not send. |
| Execute | `refund.execute`, `staff.delete` | Usually `high` or confirmation-required. |
| Batch execute | `coupon.batch_send`, `price.batch_update` | Usually high risk plus parameter-level rules. |

## Naming

Use stable action names:

- good: `refund.preview`, `refund.request.create`, `refund.execute`;
- avoid: `postData`, `update`, `doAction`, `adminApi`.

Good tool names help the model choose the right action and help operators audit what happened.

## Descriptions

Descriptions should state:

- what the tool does;
- when to use it;
- what it does not do;
- important side effects;
- required subject or tenant context.

Do not hide business rules only in prompts. Put important constraints in tool metadata and business authorization.

## Risk Selection

- Queries and previews are usually `low`.
- Requests and drafts are usually `medium`.
- Direct irreversible writes are usually `high`.
- Use parameter-level confirmation when risk depends on amount, count, tenant, or sensitive field selection.

## Response Shape

Business tools should return a clear status:

```json
{
  "ok": true,
  "status": "pending_approval",
  "message": "Refund request created and waiting for manager approval.",
  "business_id": "refund_req_1001",
  "url": "https://business.example.com/refunds/refund_req_1001"
}
```

This is not a mandatory schema, but it helps the agent distinguish executed, requested, drafted, and failed states.
