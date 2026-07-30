# BailingHub v0.1.12: Voice Transcription Policy and Fail-Closed Audio Handling

Released on 2026-07-30.

`v0.1.12` fixes voice-chat failures caused by forwarding `input_audio` to a main model that does not support it. Audio handling is now an explicit, auditable route policy instead of an implicit fallback.

## Highlights

### 1. Explicit audio modes

LLM routes now support three modes:

- `transcribe`: use a dedicated speech model first, then send the transcript to the main model;
- `inline`: send audio to the main model only when the operator explicitly confirms that the model supports audio input;
- `off`: reject voice input with deterministic guidance.

Missing audio configuration defaults to `off`. The runtime no longer guesses model capabilities.

### 2. Fail closed when transcription is unavailable

If `transcribe` is selected but its credential, model, or endpoint is missing, disabled, or unresolved, BailingHub does not fall back to the main model and does not infer content from file metadata. The task returns a clear user-facing message and records a redacted failure reason.

### 3. Two OpenAI-compatible transcription protocols

Dedicated speech models may use:

- `transcriptions`: multipart requests to `/audio/transcriptions`;
- `chat_input_audio`: Data URL `input_audio` requests to `/chat/completions`.

The second mode supports speech models exposed through a Chat Completions-compatible audio interface.

### 4. Console and schema alignment

The route editor now exposes the speech protocol and explains the separation between the speech model and the main tool-calling model. The configuration schema constrains the same protocol enum and default.

### 5. Auditable without retaining audio bodies

Speech audit events record outcome, mode, protocol, model, MIME type, and byte count. They do not retain audio content, Data URLs, credentials, or transcription request bodies. Transcript text continues through the existing task and conversation boundaries.

## Integration impact

- No database migration is required.
- Client API, executor protocol, tool signatures, approval semantics, and ACC are unchanged.
- Text chat and existing main-model settings are unaffected.
- Routes that relied on implicit audio forwarding must explicitly select `inline` or configure a dedicated speech model with `transcribe`.
- Production deployments should normally prefer `transcribe`, keeping the main model responsible for text reasoning and tool use.

## Validation

The release was validated with:

- `npm run typecheck`
- `npm test`
- `npm run web-admin:check`
- `npm run release:check`

The end-to-end path covered a real MP3 upload, dedicated speech transcription, text delivery to the main model, streaming output, and a terminal task state. Public release material does not contain internal endpoints, credentials, audio bodies, or task identifiers.

## Related documentation

- [Tool Governance Design](TOOLS_DESIGN.en.md)
- [Configuration schema](../schemas/config/common.schema.json)
- [Compatibility and Upgrade Policy](COMPATIBILITY.en.md)
- [中文发布说明](RELEASE_NOTES_v0.1.12.md)
