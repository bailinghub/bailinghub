# SDK Guide

BailingHub SDKs are helper libraries for business systems.

They do six things:

1. generate OpenAPI tool specs
2. verify signed tool calls from the hub
3. verify delivery callbacks
4. sign authenticated visitor tickets for the web widget
5. implement authorization-probe helpers
6. call hub APIs such as `/run`, `/jobs/{id}`, and `/send`

The SDK is a convenience layer. The stable contract is still OpenAPI + `x-agent-capability` metadata + HMAC signatures.

## Available SDKs

| Runtime | Path | Purpose |
|---|---|---|
| PHP 8+ | `sdk/php` | Attribute-based tool declarations and signature helpers. |
| PHP 7.3+ | `sdk/php7` | Builder-style tool declarations for older PHP projects. |
| Node.js | `sdk/node` | `buildOpenApiSpec`, `tool`, `param`, `signTicket`, `HubClient`, verification helpers. |
| Python | `sdk/python` | `build_openapi_spec`, `tool`, `param`, `sign_ticket`, `HubClient`, verification helpers. |
| Java 11+ | `sdk/java` | Standard-library SDK for JVM business services. |
| Go 1.21+ | `sdk/go` | Standard-library SDK for Go services and gateways. |
| .NET 8+ | `sdk/dotnet` | Standard-library SDK for C# business services. |

## Common Helper Surface

The exact method names follow each language's style, but every official SDK should cover the same surface:

| Capability | PHP | Node | Python | Java / Go / .NET |
|---|---|---|---|---|
| Tool spec | annotations / builder | `buildOpenApiSpec` | `build_openapi_spec` | `BuildOpenApiSpec` / `BuildOpenAPISpec` |
| Visitor ticket | `Ticket::sign` | `signTicket` | `sign_ticket` | `signTicket` / `SignTicket` |
| Tool call verification | `Verify::gate` / `Verify::toolCall` | `verifyToolCall` | `verify_tool_call` | `verifyToolCall` / `VerifyToolCall` |
| Callback verification | `Verify::callback` | `verifyCallback` | `verify_callback` | `verifyCallback` / `VerifyCallback` |
| Authz probe | `SpecServer::authzProbe` | `authzProbeResponse` | `authz_probe_response` | `authzProbeResponse` / `AuthzProbeResponse` |
| Hub APIs | `HubClient` | `HubClient` | `HubClient` | `HubClient` |

## Node Example

```js
import { buildOpenApiSpec, param, tool } from '@bailinghub/connect';

const spec = buildOpenApiSpec({
  title: 'CRM Tools',
  version: '1.0.0',
  authzProbe: { method: 'POST', path: '/.well-known/bailing/authz-probe' },
  tools: [
    tool({
      name: 'member_query',
      method: 'GET',
      path: '/api/members/{id}',
      description: 'Query member profile',
      scope: 'member.read',
      requiresSubject: true,
      params: [param('id', { in: 'path', required: true, description: 'Member ID' })],
    }),
  ],
});

console.log(JSON.stringify(spec, null, 2));
```

Verify a tool call:

```js
import { verifyToolCall } from '@bailinghub/connect';

const ok = verifyToolCall(process.env.BAILING_TOOL_SECRET, {
  method: request.method,
  pathWithQuery,
  body: rawBody,
  timestamp: request.headers.get('x-bailing-timestamp'),
  signature: request.headers.get('x-bailing-signature'),
  onBehalfOf: request.headers.get('x-bailing-on-behalf-of') || '',
  jobId: request.headers.get('x-bailing-job-id') || '',
});
```

After verification, still check your own permission table.

## Python Example

```python
from bailing_connect import build_openapi_spec, param, tool

spec = build_openapi_spec(
    title="CRM Tools",
    version="1.0.0",
    authz_probe={"method": "POST", "path": "/.well-known/bailing/authz-probe"},
    tools=[
        tool(
            name="member_query",
            method="GET",
            path="/api/members/{id}",
            description="Query member profile",
            scope="member.read",
            requiresSubject=True,
            params=[param("id", **{"in": "path", "required": True, "description": "Member ID"})],
        )
    ],
)
```

## Hub Client Example

The hub client is a thin wrapper over the stable HTTP contract:

```js
import { HubClient } from '@bailinghub/connect';

const hub = new HubClient({ baseUrl: 'https://hub.example.com', token: process.env.BAILING_CLIENT_TOKEN });

const job = await hub.run({
  requestId: 'crm_1001',
  route: 'member-support',
  input: 'Check member recharge records',
  metadata: { principal: { id: 'u1001', tenant: 't1' } },
});

const result = await hub.getJob(job.job_id);
await hub.send({ requestId: 'notice_1001', channel: 'team-im', to: 'user_001', text: 'Task completed' });
```

## PHP 8+ Example

```php
#[AiTool(
    description: 'Query member profile',
    name: 'member_query',
    scope: 'member.read',
    path: '/api/members/query',
    method: 'POST',
    readonly: true,
    idempotent: true,
    sensitive: true,
    requiresSubject: true,
)]
#[AiParam('mobile', description: 'Member mobile phone', required: true, format: 'phone')]
public function memberQuery(): void
{
}
```

## Contract Test

All SDKs are validated against the same tool contract:

```bash
npm run sdk:test
npm run sdk:test7
npm run sdk:test-node
npm run sdk:test-python
npm run sdk:test-runtime
npm run sdk:test-p1
```

These tests build SDK-generated specs, compile them through the hub's OpenAPI tool compiler, verify runtime helpers across PHP/Node/Python, and compile or source-check the Java/Go/.NET SDKs depending on the local toolchain.
