# BailingHub v0.1.11: Side-Effect Execution Journal and Uncertain-Outcome Freezing

`v0.1.11` tightens the recovery boundary for real business side effects. BailingHub must persist an execution-journal entry before dispatch. When a timeout, disconnect, restart, or audit failure makes the business outcome uncertain, the runtime freezes the execution for reconciliation instead of replaying it automatically.

## Main Changes

### Durable journal before side-effect dispatch

For a non-read-only, non-idempotent business tool, BailingHub now:

1. persists `dispatching` before sending the request;
2. persists `response_recorded` after receiving the HTTP response;
3. persists `completed` only after the result audit and terminal task ledger both succeed.

If the durable execution journal is unavailable or the pre-dispatch entry cannot be written, the request is not sent. The runtime never falls back to executing first and recording only after success.

### No automatic replay of uncertain business outcomes

The following cases converge to `reconciliation_required` with `auto_retry_allowed=false`:

- request timeout or network interruption;
- unresolved execution found after a process restart;
- business response received but result-audit persistence failed;
- response recorded but terminal task-ledger completion failed;
- partial delivery of text chunks, cards, or attachments by the built-in messaging tool.

Recovery scans unresolved journal entries before the model runs again. It does not depend on the model selecting the same tool and does not send a second request when the business effect cannot be ruled out.

### Stable business idempotency key

Side-effecting business requests now include:

```http
X-Bailing-Idempotency-Key: <stable side-effect key>
```

The key is stable for the task, acting subject, tool, and canonical arguments. It supports business-side deduplication and operator reconciliation. It does not replace:

- `X-Bailing-Signature` verification;
- final business authorization;
- domain-specific idempotency rules.

### Built-in messaging uses the same boundary

`send_message` is no longer treated as an ordinary internal action. It uses the same durable journal. If any text chunk, card, or attachment may already have been delivered, a later failure freezes the whole send instead of replaying it and risking duplicate notifications.

## Database Migration

This release adds:

```text
sql/052_tool_execution_journal.sql
```

The official Docker entrypoint runs migrations automatically. Deployments that run from source, use a custom startup path, or bypass the official entrypoint must run:

```bash
npm run db:init
```

The migration extends the existing tool-call deduplication ledger into a recoverable execution journal. It does not modify the business-system database.

## Compatibility Boundaries

- Read-only tools and explicitly idempotent tools keep their existing behavior.
- The Client API, executor protocol, ACC semantics, and final business-authorization boundary are unchanged.
- Side-effecting tools require a durable execution journal. Missing persistence fails closed before dispatch.
- BailingHub does not claim exactly-once execution. Conservative freezing may include a request that never reached the business system, so operators must reconcile against business records and the idempotency key.
- Existing signature verification remains valid if a business system does not yet consume `X-Bailing-Idempotency-Key`, but side-effect deduplication should adopt this key or a stronger domain key.

## Validation

Before release:

```bash
npm run typecheck
npm test
npm run web-admin:check
npm run docs:check
npm run examples:check
npm run security:scan
npm run release:check
```

After upgrade, verify:

1. `npm run db:init` completes and the migration ledger includes `052_tool_execution_journal.sql`;
2. `/health/ready` reports ready;
3. a side-effecting call creates `dispatching` before outbound delivery;
4. the entry becomes `completed` only after the business response, result audit, and terminal task ledger succeed;
5. simulated timeout, restart, or audit failure returns `reconciliation_required` without automatic redispatch;
6. the business system can record and deduplicate `X-Bailing-Idempotency-Key`.

## Related Documentation

- [Tool Governance Design](TOOLS_DESIGN.en.md)
- [Public Runtime Contract](CONTRACT.en.md)
- [Compatibility and Upgrade Policy](COMPATIBILITY.en.md)
- [Changelog](CHANGELOG.en.md)
