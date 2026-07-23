# BailingHub Client API

The BailingHub Client API is the stable, product-neutral boundary used by external
workflow engines and agent platforms to submit governed work and inspect its result.

Its contract version is independent from the BailingHub application version and from
adapter package versions:

```text
BailingHub 0.x
    |
    +-- bailing.client-api.v1
            |
            +-- Dify adapter 0.x
            +-- n8n adapter 0.x
            +-- future ecosystem adapters
```

The current machine-readable contract is published at:

- `/contracts/client-api/v1/manifest.json`
- `/contracts/client-api/v1/run-request.schema.json`
- `/contracts/client-api/v1/submit-response.schema.json`
- `/contracts/client-api/v1/job-response.schema.json`
- `/contracts/client-api/v1/health-response.schema.json`
- `/contracts/client-api/v1/error-response.schema.json`
- `/contracts/client-api/v1/vectors.json`

## Stable Surface

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | None | Verify the BailingHub origin |
| `POST` | `/run` | Client bearer token | Submit a governed job through an allowlisted route |
| `GET` | `/jobs/{job_id}` | Client bearer token | Read a job owned by the authenticated client |

Client requests cannot choose a project, profile, server-owned source identity, approval
result, executor, or business authority. Those decisions remain on the BailingHub and
business-system sides of the boundary.

`request_id` is a client-scoped idempotency key. A retry must reuse the same value.

## Versioning

`bailing.client-api.v1` identifies the compatibility family. The manifest's semantic
version identifies additive revisions inside that family.

- Additive response fields are compatible. Consumers must ignore fields they do not use.
- A new required request field is a breaking change.
- Authentication changes are breaking changes.
- Removing or changing the meaning of a job status is a breaking change.
- Consumers fail closed on an unknown job status until their adapter is reviewed.

Application, plugin, node, and Client API versions are deliberately not synchronized.

## Executable Compatibility Gate

The contract is not maintained as prose alone.

```bash
# Validate schemas, status semantics, aliases, and conformance vectors.
npm run client-api:contract

# Validate the current local Dify and n8n sibling repositories.
npm run client-api:ecosystem:local

# Clone the registered public adapter branches and validate them.
npm run client-api:ecosystem:clone
```

The consumer registry lives at `contracts/client-api/consumers.json`. Each adapter owns
its compatibility declaration and checker. The declaration pins endpoint method, path,
authentication shape, consumed fields, job statuses, classified HTTP failures, and the
request limits enforced by the adapter. Core CI tests current adapter branches against the
proposed core contract, while adapter CI tests itself against the current core branch.
This bidirectional gate catches both kinds of drift:

1. a core change that would break an existing adapter;
2. an adapter claim that no longer matches the core contract.

## Boundary With Executor Protocols

The Client API is not an executor protocol. OpenClaw and portable executors use the
separate claim, heartbeat, lease, and result-submission lifecycle under `/executor/*`.
Those semantics require their own versioned contract and future compatibility gate.

Keeping the two surfaces separate prevents a workflow adapter from gaining executor
authority and prevents executor lifecycle changes from destabilizing Client API consumers.
