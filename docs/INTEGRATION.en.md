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

## Embed The Chat Widget

Create a chat entry in the console, restrict its allowed origins, and embed the
hub-hosted script:

```html
<script src="<hub-url>/widget.js" data-entry="pub_xxx" async></script>
```

The widget renders safe Markdown tables without extra dependencies. A host page
that needs charts or interactive reports may register a trusted renderer while
keeping the model output declarative and untrusted. See
[WIDGET_RENDERERS.en.md](WIDGET_RENDERERS.en.md) for the versioned API, fallback
behavior, cleanup rules, and a library-neutral adapter example.

A custom chat frontend must also advertise only the renderer types it actually
supports through `client_capabilities.renderers`, treat `delta` as provisional,
discard it on `reset`, and parse rich blocks only from the authoritative
`done.reply`. See the custom-client section of
[WIDGET_RENDERERS.en.md](WIDGET_RENDERERS.en.md#custom-streaming-clients-without-widgetjs)
and the [minimal transport example](examples/custom-streaming-chat-client.mjs).

## Publish Tools

Expose a tool spec at a stable endpoint such as:

```text
/.well-known/bailing/tools.json
```

Use OpenAPI plus `x-agent-capability` fields, or an SDK that generates the same shape. The URL must return the final document directly; the new access policies do not follow redirects.

Choose one of exactly two configurable catalog policies:

| Policy | Business endpoint | Console |
|---|---|---|
| Protected (recommended) | Verify `X-Bailing-Timestamp` and `X-Bailing-Signature` with the same provider secret used for tool calls. For this GET, the body, subject, and job id are empty. Reject unsigned and invalid signatures with 401, 403, or 404, and return `Cache-Control: private, no-store` on success. | `signed_required` |
| Deliberately public | Return a valid spec to an unsigned GET. Never include secrets, private addresses, or operations that should not be discoverable. | `public_allowed` |

PHP and PHP7 applications can use `SpecServer::respond($spec, $secret)` or framework-mode `handle(...)` plus `responseHeaders($secret)`. Use `respondPublic()` or `handlePublic()` only for a deliberate public catalog. Other stacks should implement the frozen spec-signature vector in `CONTRACT.en.md` rather than inventing a second signature scheme.

After saving the provider, refresh it and compare configured intent with observed evidence. `protected` means both negative probes were rejected, `public` means an unsigned read succeeded, and `inconclusive` means the result could not be established reliably. Changing the URL, secret, or policy clears old evidence and requires another refresh. For providers created before this policy existed, follow the read-only migration procedure in [COMPATIBILITY.en.md](COMPATIBILITY.en.md#url-tool-catalog-access-policy-upgrade).

For `signed_required`, the signed request must return 2xx and both negative probes must return 401/403/404. A negative 2xx is a public mismatch. Redirects, 429, 5xx, network failures, a request longer than 10 seconds, a body larger than 5 MiB, or an invalid document are inconclusive/failures. A 404 on the correctly signed primary request is a failure; only a 404 on a negative probe counts as rejection. Failures preserve the previous cached catalog.

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
