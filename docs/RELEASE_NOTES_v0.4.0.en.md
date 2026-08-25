# BailingHub v0.4.0: Native Conversational Forms and Chat-Entry Controls

`v0.4.0` adds constrained native conversational forms to the official web widget and completes chat-entry controls for default-open presentation and browser Origin allowlists. Forms reuse the existing presentation-capability negotiation and non-blocking conversation model rather than introducing a second task state or approval protocol.

## Main changes

- **Native conversational forms**: the dependency-free official widget supports `bailing-form` v1 for text, textarea, number, date, boolean, single-select, and multi-select fields, with client/server validation, submission receipts, and history recovery.
- **Proactive information collection**: the built-in LLM receives constrained form guidance only when the client explicitly advertises `bailing-form`. When the context shows that several fields are required before the task can continue, the model may emit a form proactively without waiting for the user to request one.
- **Non-blocking continuation**: the source answer still reaches `done`. Submit, cancel, or skip creates a new user turn and job in the same thread, without adding `input_required` or changing existing SSE terminal semantics.
- **Default-open entries**: appearance configuration adds a default-false `default_open` setting. When enabled, existing official embeds open on load without page changes; the existing `data-open="1"` force-open behavior remains compatible.
- **Origin allowlist guardrails**: the console accepts exact `scheme://host[:port]` origins, canonicalizes and deduplicates them, and rejects non-allowlisted browser Origins with 403 before a job starts. Invalid formats or types return 400.
- **Ecosystem documentation discovery**: the README links to an independently maintained community plugin for DeepSeek Harness. The link is not part of BailingHub Core and does not imply official DeepSeek development, certification, endorsement, or adoption.

## Security and trust boundaries

- The server reloads the authoritative form from the source job's final reply and matches entry, identity, thread, and `submission_id`; a client-supplied Schema cannot rewrite submission rules.
- Forms cannot request passwords, tokens, API keys, private keys, or payment credentials, and cannot change identity, routing, tool eligibility, approval, business permissions, or side-effect gates.
- Ordinary form values follow existing chat semantics and enter the conversation ledger and model context. Deployers remain responsible for their own retention, privacy notice, and compliance policies.
- The Origin allowlist prevents direct browser re-embedding; it is not server authentication. An empty array remains unrestricted, and existing server or mini-program calls without Origin remain compatible. Use request signing or a business identity ticket when non-browser callers must be restricted.
- Custom or external executors do not automatically receive the built-in LLM form prompt and must implement the same public output contract themselves.

## Compatibility and upgrade

- The public contract advances additively to `bailing.contract.v2.14`; `WIDGET_API` and `rendererApiVersion` remain 1.
- There is no new database migration. `054_demo_dataset_state.sql` remains the latest migration.
- Client API v1, Kernel Host API v1, Executor Protocol, ACC, SDKs, tool signatures, approval semantics, and final business authorization remain unchanged.
- Existing chat entries remain collapsed by default, and existing `allowed_origins: []` remains unrestricted. To restrict browser embeds, save exact origins without paths, query strings, or wildcards.

## Validation

The release gate covers the complete `npm run release:check`, 554 Core tests, real-browser widget interaction, console builds, bilingual documentation, OSS boundaries, security scans, Client API contracts, and npm artifact consistency. Proactive form output, submission continuation, history recovery, default-open presentation, and non-allowlisted browser rejection also completed real end-to-end validation.

## Related documentation

- [Public runtime contract](CONTRACT.en.md)
- [Widget renderer and form contract](WIDGET_RENDERERS.en.md)
- [Streaming protocol](STREAMING.en.md)
- [Compatibility and upgrade](COMPATIBILITY.en.md)
- [中文发布说明](RELEASE_NOTES_v0.4.0.md)
