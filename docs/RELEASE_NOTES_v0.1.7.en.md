# BailingHub v0.1.7: Versioned Client API and Cross-Ecosystem Compatibility Gates

`v0.1.7` turns the public API used by external workflow and agent platforms into an independent, machine-verifiable contract and adds bidirectional compatibility gates for the Dify and n8n adapters.

## Why this patch exists

BailingHub, the Dify plugin, and the n8n node could already cooperate through `/run` and `/jobs/{job_id}`, but their constraints were spread across implementation code, documentation, and adapter-specific assumptions. With manual synchronization alone, a core field, status, or validation change could remain undetected until an adapter failed at runtime.

This release moves from "the call works today" to "each repository can prove that it remains compatible." The core owns one machine-readable contract, adapters declare the exact fields and statuses they consume, and all three repositories validate each other before merge.

## What changed

- Added the `bailing.client-api.v1` machine contract for `GET /health`, `POST /run`, `GET /jobs/{job_id}`, authentication, error classes, and job statuses;
- published the manifest, JSON Schemas, and behavioral vectors under `/contracts/client-api/v1/`;
- made core CI validate the current Dify and n8n adapters, while adapter CI validates the target core branch;
- made Client API requests strictly validate top-level fields, `route`, `metadata`, `callback_url`, `request_id`, and input length;
- retained the existing `/schemas/api/*` locations as aliases to the versioned contract;
- documented that the Client API is separate from executor protocols: OpenClaw and portable executors continue to use claim, heartbeat, lease, and result-submission semantics.

## Upgrade and compatibility

No database migration is required. Clients following the public contract with `request_id`, `route`, `input`, `metadata`, and `callback_url` require no change. Dify `0.1.2` and n8n `0.1.0` pass the contract checks.

Informal integrations that depend on undeclared top-level fields, such as a client-supplied `source`, now receive `400` and should remove those fields. BailingHub derives the source from the authenticated client identity; a caller cannot assert it.

The Client API contract version evolves independently from BailingHub, plugin, and node package versions. Additive response fields are compatible. New required request fields, authentication changes, or job-status semantic changes require a new contract major version.

## Verification

- `npm run client-api:contract`;
- `npm run client-api:ecosystem:local`;
- `npm run client-api:ecosystem:clone`;
- `npm run typecheck`;
- `npm test`;
- `npm run docs:check`;
- `npm run release:check`;
- compatibility declarations, tests, and package checks in the Dify and n8n adapter repositories.

See [CLIENT_API.md](CLIENT_API.md) for the complete contract.
