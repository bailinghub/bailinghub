# Connect Alibaba Cloud Model Studio To BailingHub

This recipe lets an Alibaba Cloud Model Studio agent or workflow submit real business
actions to a self-hosted BailingHub governance control plane through a custom MCP service.
The model does not receive business credentials or unrestricted access to business APIs.

This is a custom MCP recipe installed inside a user's Model Studio workspace. It is not a
Model Studio Marketplace listing and does not imply Alibaba Cloud certification,
recommendation, adoption, or partnership.

## Architecture And Boundary

```text
Model Studio agent / workflow
    |
    | MCP arguments: request_id, input, job_id
    v
Model Studio-hosted bailinghub-mcp-server
    |
    | fixed route + route-scoped Client Token
    v
self-hosted BailingHub
    |
    | allowlists, risk, approval, idempotency, audit, job state
    v
business system
    |
    +-- resolves the trusted subject and performs final authorization
```

`BAILINGHUB_BASE_URL`, `BAILINGHUB_CLIENT_TOKEN`, and `BAILINGHUB_ROUTE` are deployment
configuration. They are not model-selectable MCP tool arguments. The adapter uses only the
stable public Client API:

- `POST /run`
- `GET /jobs/{job_id}`

It does not call administrator, executor, approval-decision, tool-proxy, or direct
business-credential APIs.

## Prerequisites

1. An HTTPS BailingHub deployment reachable from Alibaba Cloud Function Compute.
2. A dedicated BailingHub route such as `bailian_assistant`.
3. A BailingHub Client Token restricted to that route.
4. A no-side-effect route for the first validation.

Use separate routes, Client Tokens, and MCP service instances when Model Studio
applications need different governance boundaries. Never reuse an administrator token,
executor token, business-system credential, or another ecosystem integration token.

## 1. Validate The Public Recipe

```bash
python3 docs/integrations/bailian/verify_recipe.py
```

Expected output:

```text
PASS: Bailian to BailingHub MCP recipe is structurally valid.
```

## 2. Create A Custom MCP Service

Open Model Studio MCP service management and choose **Create MCP service** and **Script
deployment**. The official script-deployment path supports `npx` for Node.js STDIO MCP
servers and hosts the process on Function Compute.

Copy [`bailian-mcp-config.json`](bailian-mcp-config.json) and replace only:

```json
{
  "BAILINGHUB_BASE_URL": "https://your-bailinghub.example.com",
  "BAILINGHUB_CLIENT_TOKEN": "your-dedicated-route-scoped-client-token",
  "BAILINGHUB_ROUTE": "bailian_assistant"
}
```

Keep the reproducible launch settings unchanged:

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "bailinghub-mcp-server@0.1.0"]
}
```

Choose Model Studio basic or turbo mode according to latency goals and budget, and select
a region near the BailingHub deployment. Script deployment may incur Function Compute
charges. Treat the current console and official documentation as authoritative for
pricing and runtime modes.

The completed configuration contains a Client Token. Never commit it to Git, paste it into
a public issue, or expose it in screenshots or articles. Rotate it in BailingHub if it
enters an untrusted environment.

## 3. Test The Three MCP Tools

After deployment, Model Studio should discover:

| Tool | Purpose |
| --- | --- |
| `submit_governed_job` | Submit through the operator-fixed BailingHub route |
| `get_governed_job` | Read the current public state of a client-owned job |
| `wait_for_governed_job` | Wait for at most 60 seconds without resubmitting |

Use a no-side-effect first request:

```text
request_id: bailian-e2e-<a new stable identifier>
input: Return exactly BAILIAN_BAILINGHUB_E2E_OK. Do not call business tools.
```

Preserve the real `job_id` returned by `submit_governed_job`, then call:

```text
wait_for_governed_job(job_id=<real job_id>, max_wait_seconds=20)
```

Never invent a `job_id`. Reuse the original `request_id` and task meaning when retrying the
same business request. A wait timeout means the job is not terminal yet; it must not cause
a replacement submission.

## 4. Attach It To An Agent Or Workflow

Attach the deployed MCP service and give the model this sequence:

```text
When a real business action is required:
1. Create and preserve one stable request_id for the business request.
2. Call submit_governed_job without subject credentials, tokens, or approval decisions.
3. Preserve the returned job_id.
4. Use wait_for_governed_job for a bounded wait, then get_governed_job if needed.
5. queued, running, and dispatched are not failures; done, error, and rejected are terminal.
6. Never treat an MCP result as the business system's final authorization.
```

## Acceptance Criteria

The minimal validation passes only when:

- Model Studio discovers and invokes all three MCP tools;
- submission can reach only the operator-fixed BailingHub route;
- an identical `request_id` does not create a duplicate job;
- the same `job_id` reaches a terminal state or remains queryable after a bounded wait;
- BailingHub preserves the approval and audit state actually produced by the selected
  route; a no-side-effect route may require no approval;
- Model Studio and the model receive no administrator, executor, or business credential;
- the business system still resolves the trusted subject and performs final authorization.

Report a result through the
[independent validation issue template](https://github.com/bailinghub/bailinghub/issues/new?template=independent_validation.yml)
and select the MCP track. Never include tokens, model keys, personal data, or production
business data.

## Current Validation Status

- The recipe JSON, pinned package version, and credential boundary are checked by the
  repository verifier.
- `bailinghub-mcp-server@0.1.0` is an independent open-source adapter and does not modify
  BailingHub Core.
- On 2026-07-27, the maintainer completed a live no-side-effect E2E in the Beijing region
  using Model Studio custom MCP script deployment and the paid turbo mode. Model Studio
  discovered all three tools, `submit_governed_job` returned `queued`, and
  `wait_for_governed_job` took the same `job_id` to `done` with
  `BAILIAN_BAILINGHUB_E2E_OK`.
- The corresponding BailingHub dispatch flow recorded the fixed `bailian-e2e` route, the
  `llm` target, and terminal state `done`. No business tools were exposed and no business
  credentials were given to the model or Model Studio.
- This is maintainer-workspace compatibility evidence. It does not imply Alibaba Cloud
  certification, recommendation, adoption, partnership, or a public Marketplace listing.
  Each deployment should still validate its own isolated route with no-side-effect input.

## Official References

- [Model Studio custom MCP](https://help.aliyun.com/zh/model-studio/custom-mcp)
- [Model Studio MCP introduction](https://help.aliyun.com/zh/model-studio/mcp-introduction/)
- [BailingHub MCP Server](https://github.com/bailinghub/bailinghub-mcp-server)
- [BailingHub MCP integration](https://www.bailinghub.com/en/integrations#mcp)
