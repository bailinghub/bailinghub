# Changelog

This changelog records public, user-visible changes starting from the first public release.

For the current integration contract, use:

- [README.en.md](../README.en.md);
- [QUICKSTART.en.md](QUICKSTART.en.md);
- [CONTRACT.en.md](CONTRACT.en.md);
- [TOOLS.en.md](TOOLS.en.md);
- [SDK.en.md](SDK.en.md).

## Recording Rules

Each public version should describe:

- new capabilities;
- integration impact;
- database schema changes;
- validation commands;
- related docs.

## Unreleased

## v0.4.0 - Native Conversational Forms and Chat-Entry Controls

Released on 2026-08-25.

- **Origin allowlist guardrails**: chat-entry saves now accept only
  `scheme://host[:port]`, canonicalize and deduplicate entries, and report the
  persisted restriction count in the console. A non-allowlisted browser Origin
  is rejected with 403 before a conversation job can start.
- **Default-open chat entries**: appearance configuration adds an opt-in,
  default-false `default_open` setting. When enabled, existing official widget
  embeds open on load without changing page markup. The existing
  `data-open="1"` force-open behavior remains compatible.
- **Native conversational forms**: the dependency-free official widget adds
  constrained `bailing-form` v1 controls for text, textarea, number, date,
  boolean, single-select, and multi-select fields, with client/server
  validation, read-only receipts, and history recovery.
- **Non-blocking continuation contract**: `POST /chat/:entry` compatibly adds
  `interaction_response`, translating submit or cancel into a new user message
  and a new job in the same thread. The source job still reaches `done`; there
  is no `input_required` or new SSE state.
- **Correlation, idempotency, and security**: the server reloads the
  authoritative form after matching source job, entry, identity, and thread,
  then deduplicates by `submission_id`. Forms cannot request credential or
  payment secrets and do not replace tool approval, business authorization, or
  side-effect gates.
- **Presentation negotiation**: the LLM receives constrained form-output
  guidance only when the client explicitly advertises `bailing-form`. Other
  clients continue with text questions, and `bailing-chart` remains an
  independent compatible capability.
- **Ecosystem documentation discovery**: the README links to an independently
  maintained community plugin for DeepSeek Harness. It is not part of
  BailingHub Core and does not imply official DeepSeek development,
  certification, endorsement, or adoption.
- **Contract and integration impact**: the public boundary advances additively
  to `bailing.contract.v2.14`; `WIDGET_API` and `rendererApiVersion` remain 1,
  with no database migration. Client API v1, Kernel Host API v1, ACC, SDKs,
  tool signatures, approval semantics, and final business authorization are
  unchanged.
- **Validation**: `npm run typecheck`, focused conversational-form contract and
  route tests, `npm run widget:renderer:test`, `npm run web-admin:check`,
  `npm run docs:check`, `npm test`, and a real local-browser form interaction
  check.
- **Related docs**: [RELEASE_NOTES_v0.4.0.en.md](RELEASE_NOTES_v0.4.0.en.md),
  [HTTP contract](CONTRACT.en.md), [Widget renderer and form
  contract](WIDGET_RENDERERS.en.md), [Streaming protocol](STREAMING.en.md), and
  [Compatibility](COMPATIBILITY.en.md).

## v0.3.4 - Anonymous Preview and Trusted Business Identity Guidance

Released on 2026-08-14.

- **Correct entry semantics**: the console and standalone page now label the former generic trial-chat action as **Anonymous Preview** and explain that it neither inherits the BailingHub administrator session nor provides a standalone business-login surface.
- **No-subject guidance**: without a trusted ticket signed by the business backend, the Agent directs the user back to the real business system to sign in and reopen or refresh the assistant. It does not ask for an account, password, token, or user ID.
- **Separate demo validation path**: after importing demo configuration, Getting Started presents a manual **Run Demo-Subject Smoke** action that creates a real job and trace. Import does not run tasks automatically, and the BailingHub administrator is not promoted into a business subject.
- **Unchanged security boundary**: without a verified subject, all `subject.required:true` tools, including read-only queries and writes, remain hidden from the Agent. The business system continues to make final authorization decisions.
- **Database and contracts**: there is no new migration, Schema, API, or protocol change. `054_demo_dataset_state.sql` remains the latest migration.
- **Validation**: complete `npm run release:check`, no-subject tool-assembly tests, anonymous-preview page contracts, real-browser console E2E, and npm artifact verification.
- **Related docs**: [RELEASE_NOTES_v0.3.4.en.md](RELEASE_NOTES_v0.3.4.en.md), [Quickstart](QUICKSTART.en.md), [Chat entry and identity contract](CONTRACT.en.md), and [Docker Demo](DEMO.en.md).

## v0.3.3 - npm Publication Metadata Correction

Released on 2026-08-09.

- **Publication identity check**: publishes npm from an independent full Git clone of the exact Tag so Registry `gitHead`, the Tag commit, and public source can be checked consistently. `v0.3.2` remains immutable history and is not overwritten, moved, or republished.
- **Unchanged runtime**: `src/`, `sql/`, `web/`, `web-admin/`, `demo/`, and `sdk/` are unchanged from `v0.3.2`; the managed demo dataset capability is carried forward as-is.
- **Database schema**: there is no new migration; `054_demo_dataset_state.sql` remains the latest migration.
- **Integration impact**: Client API, Kernel Host API v1, the chat protocol, Executor Protocol, ACC, tool signatures, approval semantics, and final business authorization are unchanged.
- **Related docs**: [RELEASE_NOTES_v0.3.3.en.md](RELEASE_NOTES_v0.3.3.en.md) and the [v0.3.2 managed demo dataset notes](RELEASE_NOTES_v0.3.2.en.md).

## v0.3.2 - Managed Demo Dataset Onboarding

Released on 2026-08-08.

- **Core-native onboarding**: adds demo dataset status, import, and clear Admin APIs together with the empty-instance console prompt. Demo targets, tool providers, routes, and clients are owned by the current tenant Core rather than an external private data layer.
- **Ownership and conflict safety**: adds a durable ownership manifest, fixed resource fingerprints, and transactional concurrency protection. Name collisions, user modifications, and external references return `409`; clearing never deletes jobs, messages, traces, or audit history.
- **Two runtime profiles**: keeps the complete Docker `full-local` demo and adds a loopback-only, stateless, read-only `stateless-readonly` profile for shared or embedded evaluation environments.
- **Database schema**: adds `054_demo_dataset_state.sql` and `bz_demo_datasets`, which store only the demo configuration set and fingerprints explicitly owned by Core. Run the official migrator before restarting the service.
- **Integration impact**: Client API, Kernel Host API v1, chat protocol, Executor Protocol, ACC, tool signatures, approval semantics, and final business authorization remain compatible. Instances without Demo Business configuration do not expose the import action.
- **Validation**: full `npm run release:check`, Docker demo coverage, npm artifact verification, and a manual candidate import, inspection, and clear flow from an empty instance.
- **Related docs**: [RELEASE_NOTES_v0.3.2.en.md](RELEASE_NOTES_v0.3.2.en.md), [Docker Demo](DEMO.en.md), [SQL migration discipline](../sql/README.en.md), and [Compatibility](COMPATIBILITY.en.md).

## v0.3.1 - PDF Parsing Security Update

Released on 2026-08-07.

- Upgraded `pdfjs-dist`, used for uploaded-PDF text extraction, from `5.7.284` to `6.2.108` to fix the arbitrary JavaScript execution risk described in GHSA-hq66-cqwq-w95j.
- Adapted to the PDF.js 6 lifecycle API and destroys the loading task on both success and failure paths.
- No database migration or configuration change is required. The Client API, Kernel Host API v1, chat protocol, Executor Protocol, ACC, tool signatures, approval semantics, and final business authorization are unchanged.
- Validation: `npm audit --audit-level=low`, real PDF extraction tests, and the complete `npm run release:check` gate.
- Related docs: [RELEASE_NOTES_v0.3.1.en.md](RELEASE_NOTES_v0.3.1.en.md), [Security policy](../SECURITY.md), and [Compatibility](COMPATIBILITY.en.md).

## v0.3.0 - Composable Core and Kernel Host API v1

Released on 2026-08-06.

- Added the stable `bailinghub/kernel-api/v1` export so an exact npm artifact can create, mount, drain, and stop Kernels. The standalone service now composes the same Kernel path instead of maintaining a second engine implementation.
- One process may host multiple isolated Kernels, provided each instance has a separate state database, runtime directory, configuration, and request prefix. Platform identity, tenant directories, registration, plans, billing, and cross-tenant authorization remain host control-plane responsibilities.
- Made Core Schema migration an explicit host/deployment step. The ledger gains SHA-256 digests; legacy rows are backfilled without replaying SQL. Three early retired migrations remain `replay: never` evidence and are never executed on a fresh Schema. Digest drift and unknown migrations fail closed.
- Included the Kernel API, official SQL, console assets, and artifact identity in the real npm tarball. `BAILINGHUB_CORE_ARTIFACT_V1` binds the exact version, active migrations, retired evidence, and aggregate digest for provisioning and upgrade checks.
- Prevented prerelease image tags from updating `latest`, even when a manual workflow requests it. Stable tags may update the stable channel according to release configuration.
- The standalone startup path, public Client API, chat protocol, Executor Protocol, ACC, tool signatures, approval semantics, and final business authorization are unchanged. Ecosystem adapters do not need a release solely for this composition API.
- The only database-shape change is the nullable `checksum_sha256` metadata column on `bz_schema_migrations`; there is no new business table or business field. Run `npm run db:init` before restarting.
- Validation: `npm run release:check` and a real npm `.tgz` install, including 515 Core tests, migration compatibility, composition lifecycle, multi-instance isolation, OSS boundaries, and image policy.
- Related docs: [RELEASE_NOTES_v0.3.0.en.md](RELEASE_NOTES_v0.3.0.en.md), [Kernel Host API v1](KERNEL_HOST_API.en.md), [SQL migration discipline](../sql/README.en.md), and [Architecture](ARCHITECTURE.en.md).

## v0.2.0 - Tool Catalog Access Protection and Active Verification

Released on 2026-08-06.

- **Explicit tool-catalog access policy:** URL-backed providers expose exactly two configurable policies: `signed_required` (default and recommended) and `public_allowed` (intentional public catalog). The console shows configured intent separately from observed evidence.
- **Active protection verification:** after a valid signed read, the hub also confirms that unsigned and invalid-signature reads are rejected. A mismatch fails closed and preserves the previous cache. Public mode sends only an unsigned request and never silently falls back to a signed read.
- **Business integration impact:** a protected spec endpoint should use the same provider secret as tool calls, reject unsigned or invalid requests with 401, 403, or 404, and return `Cache-Control: private, no-store`. Deliberate public access must be explicit in both code and console. Tool calls remain signed and subject to final business authorization in either mode.
- **SDKs:** PHP and PHP7 `SpecServer` add `handlePublic()`, `respondPublic()`, and `responseHeaders()`. Protected bare-PHP responses automatically disable caching, while the older `null` public call remains compatible.
- **Database schema:** `053_tool_spec_access_policy.sql` adds policy and latest-probe columns to `bz_tool_providers`. Existing URL providers keep the previous signed-fetch behavior. They may still be disabled or updated in descriptive, governance, retrieval, and other non-catalog fields without choosing a policy; changing the catalog URL, secret, auto-refresh, re-enabling, or another catalog-sensitive setting first requires one of the two access policies. Internal migration state is documented only in [COMPATIBILITY.en.md](COMPATIBILITY.en.md#url-tool-catalog-access-policy-upgrade).
- **Validation:** run `npm run release:check`, verify that no migration is pending and cached specs are unchanged, then use the status matrix in [COMPATIBILITY.en.md](COMPATIBILITY.en.md#url-tool-catalog-access-policy-upgrade) against real business endpoints.
- **Related docs:** [RELEASE_NOTES_v0.2.0.en.md](RELEASE_NOTES_v0.2.0.en.md), [CONTRACT.en.md](CONTRACT.en.md), [INTEGRATION.en.md](INTEGRATION.en.md#publish-tools), [TOOLS.en.md](TOOLS.en.md), and [SDK.en.md](SDK.en.md).

## v0.1.16 - Bounded Tool Runtime and Resilient Semantic Retrieval

Released on 2026-08-05.

- Made the runtime derive its bounded model rounds from each route's existing `tools.max_calls` budget. The model receives used and remaining counts after every business-tool round, is guided to converge near the limit, and loses tool access at exhaustion.
- Added a streaming and non-streaming output gate for DSML-like internal tool-protocol markup. Provisional text is discarded through `reset`, one tool-free rewrite is allowed, repeated violations fail closed, and text protocol is never parsed for execution.
- Added background index prewarming, stale-while-revalidate service, single-flight refresh, bounded index and credential reads, abortable query embeddings, and progressive tool-discovery fallback.
- Serialized same-provider reindexing, reread authoritative configuration under the lock, atomically replaced changed embedding coordinates, and added sanitized phase-latency diagnostics.
- Replaced the widget's misleading close glyph with an accessible minimize control while preserving the existing hide-and-reopen behavior.
- Added independent community governance recipes for RuoYi-Vue-Pro after-sale lookup/refund and JeecgBoot user lookup/freeze-unfreeze, including Agent-facing OpenAPI, adapter contracts, and verification scripts. They do not imply official upstream integration or endorsement.
- No database migration is required.
- ACC, the Client API version, executor protocol, tool signatures, approval semantics, and final business authorization are unchanged. Existing routes require no configuration migration. Custom chat clients should continue discarding provisional text on every `reset` and treating `done.reply` as authoritative.
- Validation: `npm run release:check` plus both community-recipe verification scripts, covering budget convergence, protocol interception, retrieval timeout fallback, cache refresh, atomic reindexing, and widget minimize behavior.
- Related docs: [RELEASE_NOTES_v0.1.16.en.md](RELEASE_NOTES_v0.1.16.en.md), [TOOLS_DESIGN.en.md](TOOLS_DESIGN.en.md), [OPERATIONS.en.md](OPERATIONS.en.md), [RuoYi-Vue-Pro recipe](integrations/ruoyi-vue-pro/README.en.md), and [JeecgBoot recipe](integrations/jeecgboot/README.en.md).

## v0.1.15 - Trusted Rich Rendering and Chat Reliability

Released on 2026-08-01.

- Added versioned trusted-renderer registration, allowlisted dispatch, cleanup, and safe fallback to the dependency-free official widget. Model-generated HTML or scripts are never executed.
- Added presentation-only client capability negotiation. It does not change identity, routing, tools, approval, or final business authorization.
- Made `delta` provisional, `reset` discard it, and `done.reply` replace the provisional bubble as the only authoritative final text.
- Bounded additional tool discovery and stopped it when no new tools are found. Tool error pages are compacted for model context while full evidence remains in audit, and LLM traces include low-sensitivity latency and size measurements.
- No database migration is required.
- Existing clients are unchanged. Custom clients enabling rich content must advertise capabilities explicitly and implement the complete SSE lifecycle and trusted-rendering boundary.
- Validation: `npm run release:check`, including renderer registration/fallback/cleanup, capability negotiation, provisional-message replacement, and custom-client example syntax.
- Related docs: [RELEASE_NOTES_v0.1.15.en.md](RELEASE_NOTES_v0.1.15.en.md), [WIDGET_RENDERERS.en.md](WIDGET_RENDERERS.en.md), [STREAMING.md](STREAMING.md), and [INTEGRATION.en.md](INTEGRATION.en.md).

## v0.1.14 - Transient Progress Feedback for Streaming Chat

Released on 2026-07-30.

- The official web widget promotes a short pre-tool acknowledgement into a transient progress bubble and shows explicit tool, model, retry, and fallback phases.
- The transient bubble is removed as soon as the formal streamed answer begins. Only the formal answer remains in chat history.
- The feature presents model-authored acknowledgement text and runtime phases only; it does not expose hidden reasoning. Progress copy is whitespace-normalized and length-bounded.
- Progress animation respects `prefers-reduced-motion`, and failed or background-processing states use deterministic copy.
- No database migration is required.
- Client API, streaming event protocol, executor protocol, tool signatures, approval semantics, and ACC are unchanged. The official widget adopts the behavior automatically; custom chat UIs must consume the existing `delta`, `reset`, `phase`, and `done` events themselves.
- Validation: `node --check web/widget/widget.js`, targeted public-route widget tests, `npm run typecheck`, and `npm run release:check`.
- Related docs: [RELEASE_NOTES_v0.1.14.en.md](RELEASE_NOTES_v0.1.14.en.md), [independent validation](INDEPENDENT_VALIDATION.en.md), and [CONTRACT.en.md](CONTRACT.en.md).

## v0.1.13 - Voice Transcription and Distribution-Version Alignment

Released on 2026-07-30.

- Carried forward the `v0.1.12` explicit `transcribe`, `inline`, and `off` policies, dedicated speech-model transcription, and fail-closed boundary without changing their semantics.
- Aligned the one-line installer, image Compose file, image publishing and inspection scripts, independent-validation baseline, and Issue template on `v0.1.13`.
- Made release distribution checks compare the package version, installer fallback, default Compose images, and public validation docs so a stale entry point cannot silently pull an older image.
- No database migration is required.
- Client API, executor protocol, tool signatures, approval semantics, speech policies, and ACC are unchanged. `v0.1.12` users need no configuration migration.
- Validation: `npm run release:check`, distribution-sync dry-run, official image-tag inspection, and one-line installer entry-point review.
- Related docs: [RELEASE_NOTES_v0.1.13.en.md](RELEASE_NOTES_v0.1.13.en.md), [independent validation](INDEPENDENT_VALIDATION.en.md), and [COMPATIBILITY.en.md](COMPATIBILITY.en.md).

## v0.1.12 - Voice Transcription Policy and Fail-Closed Audio Handling

Released on 2026-07-30.

- Added explicit `transcribe`, `inline`, and `off` audio modes. Missing configuration defaults to `off` instead of guessing whether the main model supports audio.
- Made missing, disabled, or unresolved transcription configuration fail closed with deterministic guidance. Audio is not forwarded to the main model and content is never guessed.
- Added both `/audio/transcriptions` multipart and `/chat/completions` Data URL `input_audio` protocol support.
- Added the speech protocol selector to the route console and aligned the machine-readable configuration schema.
- Speech audits record mode, protocol, model, MIME type, byte count, and outcome without retaining audio bodies, Data URLs, or credentials.
- No database migration is required.
- Text chat, Client API, executor protocol, tool signatures, approval semantics, and ACC are unchanged. Routes that relied on implicit audio forwarding must explicitly select `inline` or configure `transcribe`.
- Validation: `npm run typecheck`, `npm test`, `npm run web-admin:check`, `npm run release:check`, plus an end-to-end MP3 transcription and streaming-response run.
- Related docs: [RELEASE_NOTES_v0.1.12.en.md](RELEASE_NOTES_v0.1.12.en.md), [TOOLS_DESIGN.en.md](TOOLS_DESIGN.en.md), and [COMPATIBILITY.en.md](COMPATIBILITY.en.md).

## v0.1.11 - Side-Effect Execution Journal and Uncertain-Outcome Freezing

Released on 2026-07-28.

- Persisted `dispatching` before outbound delivery for non-read-only, non-idempotent business tools, `response_recorded` after the HTTP response, and `completed` only after the result audit and terminal task ledger succeed.
- Made timeout, disconnect, restart recovery, result-audit failure, and terminal-ledger failure converge to `reconciliation_required` with `auto_retry_allowed=false`. Recovery scans unresolved execution entries before the model runs again.
- Added the stable `X-Bailing-Idempotency-Key`, bound to the task, acting subject, tool, and canonical arguments for business-side deduplication and reconciliation. It does not replace signature verification or final business authorization.
- Applied the same durable boundary to `send_message`; partial text, card, or attachment delivery is frozen instead of replayed automatically.
- Added `052_tool_execution_journal.sql`, extending the existing tool-call deduplication ledger into a recoverable execution journal.
- Read-only and explicitly idempotent tools keep their existing behavior. Deployments must apply the new migration, and business systems should consume the stable idempotency key for side-effect deduplication.
- Validation: `npm run typecheck`, `npm test`, `npm run web-admin:check`, `npm run docs:check`, `npm run examples:check`, `npm run security:scan`, and `npm run release:check`.
- Related docs: [RELEASE_NOTES_v0.1.11.en.md](RELEASE_NOTES_v0.1.11.en.md), [TOOLS_DESIGN.en.md](TOOLS_DESIGN.en.md), [CONTRACT.en.md](CONTRACT.en.md), and [COMPATIBILITY.en.md](COMPATIBILITY.en.md).

## v0.1.10 - Instance Branding and Ecosystem Integration Improvements

Released on 2026-07-27.

- Added console-managed site name, browser title, description, keywords, login copy, logo, and favicon for administrators with `admins:manage`. Values persist in `bz_instance_branding` across upgrades and restarts.
- Added a replaceable `InstanceBrandingProvider` boundary. The open-source edition uses local storage; a future platform may become the single owner and make instance-local settings read-only without dual writes.
- Added public `GET /branding` and logo/favicon asset endpoints that expose display data only. Image formats are detected from bytes and bounded by type and size.
- Improved model-ID diagnostics when a failed identifier contains whitespace. Added a Tencent Cloud TokenHub preset and the exact `kimi-k3` ID while preserving valid custom aliases.
- Added bilingual DeepSeek V4 tool-calling E2E and Alibaba Cloud Bailian remote-MCP recipes with verification scripts.
- Added `051_instance_branding.sql`, which creates only the singleton instance-branding table.
- Client API, executor protocol, tool signatures, approval semantics, and ACC are unchanged. Existing deployments retain default branding after upgrade.
- Validation: `npm run typecheck`, `npm test`, `npm run web-admin:check`, `npm run docs:check`, `npm run security:scan`, and `npm run release:check`.
- Related docs: [RELEASE_NOTES_v0.1.10.en.md](RELEASE_NOTES_v0.1.10.en.md), [COMPATIBILITY.en.md](COMPATIBILITY.en.md), [DeepSeek integration](integrations/deepseek/README.en.md), and [Alibaba Cloud Bailian MCP integration](integrations/bailian/README.en.md).

## v0.1.9 - Optional OpenMetrics Operational Metrics

Released on 2026-07-24.

- Added an optional `GET /metrics` OpenMetrics endpoint. It is disabled by default and requires a dedicated Bearer token when enabled; query-string tokens and reuse of the administrative root token are rejected.
- Added stable, low-cardinality operational metrics for job states, recent terminal outcomes, oldest queue age, delayed jobs, expired leases, blocked threads, pending approvals, executor heartbeat state, audit-write failures, runtime pause state, and collector health. Job, tenant, principal, argument, and business-payload labels are never emitted.
- Isolated and bounded state and control-plane collectors independently. A failed collector does not suppress remaining metrics, and external state/config implementations may continue omitting the new optional aggregation methods.
- Added `050_operational_metrics_indexes.sql`, containing only indexes for terminal-window and executor-heartbeat aggregation.
- Default behavior is unchanged. Client API, executor protocol, tool signatures, and ACC semantics are unchanged. Only deployments enabling `/metrics` need the three `BAILING_METRICS_*` variables.
- Validation: `npm run typecheck`, `npm test`, `npm run docs:check`, `npm run security:scan`, and `npm run release:check`.
- Related docs: [RELEASE_NOTES_v0.1.9.en.md](RELEASE_NOTES_v0.1.9.en.md), [OPERATIONS.en.md](OPERATIONS.en.md), and [COMPATIBILITY.en.md](COMPATIBILITY.en.md).

## v0.1.8 - Create-Once Initial Administrator Bootstrap

Released on 2026-07-24.

- Added paired `BAILING_BOOTSTRAP_ADMIN_USERNAME` and `BAILING_BOOTSTRAP_ADMIN_PASSWORD` settings. The account is created only when the admin table is empty. Restarts, upgrades, and container recreation against the same database never update an existing username, password, role, or enabled state.
- Serialized concurrent multi-replica bootstrap with a MySQL named lock and transaction. Startup fails if the initialization lock cannot be acquired instead of continuing from an uncertain state.
- Kept `npm run admin:create` as the explicit account-creation and password-reset command. The automatic startup path never invokes it. Demo seeding now uses the same create-once contract, no longer resets an admin password during restart, and does not print passwords in service logs.
- No database migration or public API, executor, tool-signature, or ACC semantic change is required. The two bootstrap variables must be configured together. Reinstallation with the same database preserves the account; a destructive fresh database installation creates a new initial account.
- Validation: `npm run typecheck`, `npm test`, `npm run security:scan`, plus real-MySQL checks for first creation, restart persistence after a password change, concurrent cold starts, and log redaction.
- Continuous regression: Docker demo CI changes the administrator password explicitly in real MySQL, restarts the container, and verifies bootstrap configuration did not overwrite the stored credential.
- Password-update compatibility: when no role is supplied, the administrator repository uses `admin` only as the insert default while preserving the role of an existing account, avoiding a MySQL non-null rejection before duplicate-key update.
- Related docs: [RELEASE_NOTES_v0.1.8.en.md](RELEASE_NOTES_v0.1.8.en.md), [QUICKSTART.en.md](QUICKSTART.en.md), and [OPERATIONS.en.md](OPERATIONS.en.md).

## v0.1.7 - Versioned Client API and Cross-Ecosystem Compatibility Gates

Released on 2026-07-23.

- Added `bailing.client-api.v1`, with a manifest, JSON Schemas, and behavioral vectors for `/health`, `/run`, `/jobs/{job_id}`, authentication, error classes, and job statuses.
- Added bidirectional compatibility gates: core CI validates the Dify and n8n adapters, while adapter CI validates the target core branch.
- Made the public Client API strictly validate top-level fields, route, metadata, callback URL, request id, and input length. The authenticated client identity, rather than request data, determines the source.
- Kept OpenClaw and portable executors outside the Client API. They continue to use the separate claim, heartbeat, lease, and result-submission protocol.
- No database migration is required. Documented clients remain compatible; informal integrations that use undeclared top-level fields must remove those fields.
- Validation: `npm run client-api:contract`, `npm run client-api:ecosystem:local`, `npm run client-api:ecosystem:clone`, `npm run typecheck`, `npm test`, and `npm run release:check`.
- Related docs: [RELEASE_NOTES_v0.1.7.en.md](RELEASE_NOTES_v0.1.7.en.md) and [CLIENT_API.md](CLIENT_API.md).

## v0.1.6 - Independent Validation Paths and Post-Install Privilege Hints

Released on 2026-07-21.

- Made the fresh Ubuntu/Debian one-line installer the recommended core independent-validation path while retaining a complete local source-reproduction path.
- Made the installer print either `docker compose` or `sudo docker compose` according to the current session's actual Docker access, avoiding immediate socket-permission failures before new group membership takes effect.
- Clarified that validation must not run on a production host, production network, or Docker environment with important data, and that reports must exclude passwords, tokens, complete `.env` files, and production data.
- Split the independent-validation Issue tracks into one-line installer, source Docker, Dify, and executor paths. A commit SHA is required only for source reproduction.
- Existing deployments require no migration. Public HTTP contracts, SDKs, signature formats, ACC semantics, database schemas, and business-image runtime behavior are unchanged.
- Validation: `sh -n scripts/install.sh`, `npm run docs:check`, `npm run release:check`, plus an isolated Ubuntu 24.04 installation covering privilege hints, health, the 10-check smoke suite, the complete demo E2E flow, and cleanup boundaries.
- Related docs: [RELEASE_NOTES_v0.1.6.en.md](RELEASE_NOTES_v0.1.6.en.md) and [INDEPENDENT_VALIDATION.en.md](INDEPENDENT_VALIDATION.en.md).

## v0.1.5 - Reliable One-Line Installer Arguments and Clean-Server Compatibility

Released on 2026-07-21.

- Fixed custom installer arguments so install mode, ports, public host, registry overrides, install directory, and repository reference are attached to the `sh` process that executes the installer rather than only to `curl`.
- Improved clean-server dependency setup by detecting whether the configured apt repository provides `docker-compose-plugin` or `docker-compose-v2` before installing Docker Compose.
- Stopped presenting a private address as a remote access URL when public-address discovery fails. The installer now explains when `localhost` must be replaced and continues to support an explicit `BAILING_PUBLIC_HOST`.
- Added a release regression guard that scans public scripts and docs for installer commands that attach `BAILING_*` variables to the downloader instead of the installer process.
- The default one-line install command is unchanged. Custom commands should use `curl ... | env BAILING_*=... sh`. Public HTTP contracts, SDKs, signature formats, and database schemas are unchanged.
- Validation: `sh -n scripts/install.sh`, `npm run docs:check`, and `npm run release:check`, plus default and custom-argument installs on a clean Ubuntu 24.04 server, the 10-check smoke suite, the complete demo E2E flow, and restart persistence.
- Related docs: [RELEASE_NOTES_v0.1.5.en.md](RELEASE_NOTES_v0.1.5.en.md), [QUICKSTART.en.md](QUICKSTART.en.md), and [DEMO.en.md](DEMO.en.md).

## v0.1.4 - Real Web Chat Streaming and Reconnectable SSE

Released on 2026-07-20.

- Added real incremental output for embedded chat when an `llm` target uses an OpenAI-compatible streaming endpoint.
- Added `bailing.chat.stream.v1` events (`phase`, `reset`, and `delta`), monotonic per-job event IDs, `Last-Event-ID` replay, and a bounded short-lived replay window.
- Incremental text is transport-only. Conversation history, callbacks, delivery, and audit do not persist every fragment; the canonical `done` event is always rebuilt from the final job record.
- A provider is retried once without streaming only when it explicitly rejects streaming. Trace records chunk counts, character counts, finish reason, and first-fragment latency without recording fragment text.
- Existing clients may ignore the new events and continue consuming `done`. Set `target_config.streaming` to `false` to disable provider streaming. No database migration is required.
- Validation: `npm run typecheck`, `npm test`, `npm --prefix web-admin run build`, and `npm run docs:check`.
- Related docs: [RELEASE_NOTES_v0.1.4.en.md](RELEASE_NOTES_v0.1.4.en.md), [STREAMING.en.md](STREAMING.en.md), [CONTRACT.en.md](CONTRACT.en.md), and [OPERATIONS.en.md](OPERATIONS.en.md).

## v0.1.3 - Portable Executor Onboarding and OpenClaw Adapter

Released on 2026-07-17.

- Added the portable `connect-bailinghub-executor` Skill, covering installation decisions, token handling, the generic command wrapper, the OpenClaw recipe, the direct protocol, and explicit acceptance criteria.
- Replaced the long console copy block with a minimal bootstrap containing only the hub URL, target, route context, and Skill URL. The receiving agent reads the Skill and confirms the local setup without putting the executor token in chat.
- Added the dependency-free `openclaw-stdio.mjs` adapter, which maps BailingHub jobs to local OpenClaw agent calls, preserves session continuity, and writes only the final response to stdout.
- The generic executor now prefers `BAILING_EXECUTOR_TOKEN`, keeps `--token` for compatibility, reports an independent heartbeat during long jobs, and returns `claim_token` so the hub can reject stale results after reassignment.
- No database migration is required. `/run`, SDKs, signature formats, and existing executor HTTP endpoints are unchanged. Existing `--token` commands remain compatible, while local environment variables or a secret manager are recommended.
- Validation: `npm run typecheck`, `npm test`, `npm --prefix web-admin run build`, `npm run release:check`, plus a representative OpenClaw end-to-end run.
- Related docs: [RELEASE_NOTES_v0.1.3.en.md](RELEASE_NOTES_v0.1.3.en.md), [QUICKSTART.en.md](QUICKSTART.en.md), and [INTEGRATION.en.md](INTEGRATION.en.md).

## v0.1.2 - Server Token and Derived Credential Hardening

Released on 2026-07-17.

- Removed the public literal fallback from task tool tokens, job callbacks, and alert webhook signatures. Signing paths now fail closed when the root token is missing.
- Only development mode bound to a loopback host may run without a token. Production or non-loopback listeners require an explicit non-placeholder `BAILING_TOKEN` of at least 24 characters.
- Source and image Compose files no longer provide a predictable machine-admin token. The docs generate a random value, while the one-line installer continues to generate and persist one automatically.
- The tokenless development-admin fallback is also restricted to loopback mode, and the security scanner rejects legacy fallback expressions and predictable Compose admin tokens.
- Public HTTP, SDK, signature format, and database contracts are unchanged. Existing production or externally reachable deployments must set a strong `BAILING_TOKEN` before upgrading.
- Validation: `npm run typecheck`, `npm test`, `npm run security:scan`, and `npm run release:check`.
- Related docs: [RELEASE_NOTES_v0.1.2.en.md](RELEASE_NOTES_v0.1.2.en.md), [SECURITY.md](../SECURITY.md), and [QUICKSTART.en.md](QUICKSTART.en.md).

## v0.1.1 - Widget Operations and Stricter Integration Boundaries

Released on 2026-07-13.

- Chat entries can be paused or resumed from the console without removing embed code. Disabled entries hide the launcher and panel while server endpoints continue to reject access.
- Widget footer attribution can be shown, hidden, or customized. Existing entries keep the current BailingHub attribution by default.
- OpenAPI compilation fails closed for `cookie`, unknown, or missing parameter locations instead of silently mapping them to query. ACC `timeout_ms` remains integer-only, with an actionable diagnostic for quoted numeric strings.
- Application images publish to both Aliyun ACR and GHCR. GitHub main and release tags mirror to Gitee, README images render on both platforms, and community derivative and ecosystem collaboration principles are documented.
- Existing chat entries and public contracts remain compatible. Attribution reuses the existing `appearance` JSON, so no database migration is required.
- Validation: `npm run typecheck`, `npm test`, `npm --prefix web-admin run build`, and `npm run release:check`.
- Related docs: [RELEASE_NOTES_v0.1.1.en.md](RELEASE_NOTES_v0.1.1.en.md), [CHANNELS.en.md](CHANNELS.en.md), and [CONTRACT.en.md](CONTRACT.en.md).

## v0.1.0 - First Public Release Candidate

`v0.1.0` is the first public release candidate. It is intended for self-hosted evaluation, small pilot integrations, and architecture review.

Included:

- trigger routes;
- MySQL-backed runtime state;
- DB-backed job scheduling and lease recovery;
- tool providers and OpenAPI `x-agent-capability` governance metadata;
- centralized rate-limit ledger;
- approval intent and frozen argument snapshots;
- audit and trace records;
- Docker demo and demo business app;
- PHP, PHP 7, Node, and Python SDK examples;
- official website docs and one-line installer;
- OSS export guard, docs checks, example checks, and release audit scripts.
- ACC operation timeouts are preserved from 1 to 600000 milliseconds and rejected when out of range; audit write failures emit redacted structured events with a process-local `/health` counter; model credential source conflicts are diagnosed while traces record only the non-secret `config` or `db` source.

Production deployments still need environment-specific domain, TLS, backups, monitoring, secret management, credential rotation, and approval workflow integration.
