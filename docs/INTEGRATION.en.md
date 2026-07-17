# Third-Party Integration Guide

This guide is for business systems that want to connect to BailingHub.

## Integration Responsibilities

| Side | Responsibility |
|---|---|
| Business system | Trigger jobs, publish selected tools, verify signatures, authorize subjects, and consume callbacks. |
| BailingHub | Route tasks, assemble context, govern tools, record trace/audit, emit approval intents, and deliver results. |

## Trigger Jobs

Use `POST /run` with a route key and business idempotency key.

```json
{
  "request_id": "order-10001-ai-001",
  "route": "order_assistant",
  "input": "Analyze why this order has not shipped.",
  "metadata": {
    "principal": {
      "id": "u_42",
      "tenant": "tenant_100",
      "roles": ["manager"]
    },
    "order_id": "SO20260701001"
  },
  "callback": "https://business.example.com/ai/callback"
}
```

## Publish Tools

Expose a tool spec at a stable endpoint such as:

```text
/.well-known/bailing/tools.json
```

Use OpenAPI plus `x-agent-capability` fields, or an SDK that generates the same shape.

## Verify Tool Calls

Every tool call from the hub must be verified:

- signature;
- timestamp freshness;
- tool name;
- job id;
- on-behalf-of subject.

After verification, apply your own business authorization. Do not treat signature verification as permission approval.

## Handle Approvals

If a tool call becomes high-risk or confirmation-required, the hub emits an approval intent with a frozen argument snapshot. The business system should usually route that intent to its own approval workflow.

Approvers do not need to be hub administrators.

## Consume Results

You can use polling or signed callbacks:

- polling: `GET /jobs/{job_id}`;
- callback: verify `X-Bailing-Signature` before consuming the result.

Business systems should keep a fallback path in case callbacks fail or are retried.

## Connect an External OpenClaw Executor

Register an `executor` target and issue a target-scoped executor token in the console. The versioned machine-readable workflow is available at `<hub-url>/connect/skills/connect-bailinghub-executor/SKILL.md`. On the machine that will run OpenClaw:

```bash
curl -fsSL <hub-url>/connect/executor.mjs -o bailing-executor.mjs
curl -fsSL <hub-url>/connect/openclaw-stdio.mjs -o bailing-openclaw.mjs
read -rsp 'BailingHub executor token: ' BAILING_EXECUTOR_TOKEN && printf '\n'
export BAILING_EXECUTOR_TOKEN
node bailing-executor.mjs --hub <hub-url> --targets <target-name> \
  --runtime openclaw --cmd 'node bailing-openclaw.mjs --agent bailinghub-executor'
```

The generic executor owns claim leases, heartbeats, retries, and result reporting. The OpenClaw adapter maps BailingHub session ids to OpenClaw sessions and emits only the final reply on stdout.

Use a dedicated OpenClaw agent with a minimal tool profile. The adapter does not forward business-tool credentials by default; connect governed tool invocation only after the basic claim/result path has been verified.
