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

There are no unreleased changes.

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
