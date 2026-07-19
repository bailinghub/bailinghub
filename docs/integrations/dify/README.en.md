# Dify + BailingHub Minimal Integration Recipe

> Status: maintainer-verified with a real Dify Cloud import and a harmless end-to-end request on 2026-07-18. Independent community reproduction is still pending. This document does not imply an official Dify partnership or certification.

[中文](README.md)

## When To Use This Recipe

When a Dify Agent or Workflow needs to operate an existing business system, do not import governed business APIs and business credentials directly into Dify. Expose only the BailingHub control plane:

```text
Dify Agent / Workflow
  -> POST /run                 create a governed job
  -> GET /jobs/{job_id}       read job status and result
  -> BailingHub               route, subject, risk, approval, and audit
  -> business API             final authorization remains in the business system
```

This shape preserves three important boundaries:

1. Dify does not hold business-system credentials or call governed business APIs directly.
2. The dedicated Dify client can use only explicitly allowed BailingHub routes and cannot override `project` or `profile`.
3. Retries for the same business request reuse `request_id`, allowing BailingHub to enforce client-scoped idempotency.

## Prerequisites

Create a dedicated client in your self-hosted BailingHub instance:

- generate a dedicated Client Token; do not use an admin or executor token;
- allow only the routes Dify needs;
- configure an appropriate per-minute rate limit;
- do not provide business API keys, subject credentials, or production management credentials to Dify.

This recipe requires the BailingHub MySQL backend because client route allowlists and route resolution use persistent configuration.

## Import Into Dify

1. Open [bailinghub-control-plane.openapi.json](bailinghub-control-plane.openapi.json).
2. Replace `servers[0].url` with the HTTPS origin of your BailingHub instance, without a trailing slash.
3. In Dify, open `Tools -> Swagger API Tool -> Add Swagger API Tool`.
4. Paste the OpenAPI JSON.
5. Configure request-header authentication:
   - header prefix: `Bearer`
   - key: `Authorization`
   - value: the raw BailingHub Client Token, without another `Bearer ` prefix
6. Save the tool. Dify should create:
   - `bailinghub_start_job`
   - `bailinghub_get_job`

## Agent Or Workflow Rules

Use the following as tool guidance:

```text
To operate a business system, call bailinghub_start_job first. Never call the business API directly.
request_id must be unique for the business request. Reuse it only when retrying the same request.
Save the returned job_id and query it with bailinghub_get_job.
queued, running, and dispatched are non-terminal. done is success. error or rejected is terminal failure.
Do not change route arbitrarily. Never put BailingHub tokens, business credentials, or subject credentials in input.
```

Generate `request_id` in a deterministic Workflow node rather than letting the model invent it. For example:

```text
dify:<conversation-id>:<workflow-run-id>:<step-id>
```

## Status Handling

| Status | Meaning | Next Dify Action |
| --- | --- | --- |
| `queued` | Accepted by the hub | Poll the same `job_id` later |
| `running` | Running in the hub | Poll later |
| `dispatched` | Claimed by an external executor | Poll later |
| `done` | Completed | Use `result` |
| `error` | Failed | Surface `error`; do not mutate arguments and retry automatically |
| `rejected` | Rejected by governance or a business boundary | Surface `error` and hand control to a user or administrator |

## Verified And Not Claimed

Verified:

- the OpenAPI document exposes only `/run` and `/jobs/{job_id}`;
- the start request exposes only `request_id`, `route`, and `input`;
- Dify Cloud creates both tools and sends a custom `Authorization` header;
- a real network request completed `queued -> done`;
- BailingHub enforces the client route allowlist, rate limit, job ownership, and idempotency key.

Not claimed:

- this does not prove that every model can reliably select both tools and poll to completion autonomously;
- Dify's Swagger API Tool does not provide bounded polling by itself; the Agent or Workflow must handle status explicitly;
- using Dify as a BailingHub external executor requires separate claim, heartbeat, tool-proxy, and result adapters.

## Verification

Run the dependency-free structural check without network access:

```bash
python3 verify_contract.py
```

Expected output:

```text
PASS: Dify -> BailingHub minimal integration contract is structurally valid.
```

With a dedicated Client Token and a harmless test route, verify the real request path:

```bash
BAILINGHUB_TOKEN='<dedicated client token>' \
python3 verify_e2e.py \
  --base-url 'https://hub.example.com' \
  --route 'dify-e2e'
```

The verifier never prints the token. Do not run the default probe against a production write route, and do not use an admin token.

## Feedback

If you reproduce this integration independently, use the [independent validation report](https://github.com/bailinghub/bailinghub/issues/new?template=independent_validation.yml) and include the Dify shape you used (Agent or Workflow), the BailingHub version, the sanitized status sequence, and any friction you found. See the [Independent Validation Task](../../INDEPENDENT_VALIDATION.en.md) for the evidence rules and safety boundary. Never include tokens, business credentials, or production data.

## Primary References

- [Dify Tool Plugin](https://docs.dify.ai/en/develop-plugin/dev-guides-and-walkthroughs/tool-plugin)
- [Dify plugin type selection](https://docs.dify.ai/en/develop-plugin/getting-started/choose-plugin-type)
- [Dify Tool return values](https://docs.dify.ai/en/develop-plugin/features-and-specs/plugin-types/tool)
- [BailingHub HTTP contract](../../CONTRACT.en.md)
- BailingHub `src/routes/run.ts`
- BailingHub `src/routes/private.ts`
