# v0.1.4 Release Notes

BailingHub `v0.1.4` adds real model-token streaming to embedded web chat and defines a reconnectable SSE event protocol. Model generation is now observable before job completion, while the final job record remains the canonical source for conversation history, callbacks, delivery, and audit.

## Highlights

### 1. OpenAI-compatible model streaming

An `llm` target now attempts `stream:true` by default:

- provider text fragments are parsed incrementally;
- first-fragment latency, chunk count, character count, and finish reason are recorded as trace metadata;
- fragment text is not copied into trace, audit, or conversation ledgers;
- a non-streaming retry occurs only when the provider explicitly rejects streaming.

Set `streaming:false` in the target configuration when a compatible endpoint should remain non-streaming.

### 2. Reconnectable SSE event protocol

The new `bailing.chat.stream.v1` protocol adds these events alongside the existing terminal event:

- `phase`: the current execution phase;
- `reset`: discard incomplete provisional text;
- `delta`: append a provisional text fragment;
- `done`: the canonical terminal result rebuilt from the final job record.

Each job uses monotonically increasing event IDs. A reconnecting client may send `Last-Event-ID` for bounded short-term replay. If a complete replay is unavailable, the server emits `reset` so the client cannot silently concatenate discontinuous text.

### 3. Incremental web widget rendering

The zero-dependency widget renders model output before job completion and converges correctly after reconnects, resets, and terminal events. Existing clients remain compatible: they may ignore unknown events and continue consuming only `done`.

## Security and audit boundary

- Incremental text is provisional transport data, not a business outcome or approval evidence.
- Conversation history, callbacks, delivery, and audit bodies do not persist every fragment.
- `done` always comes from the canonical final job record.
- Final business authorization remains with the business system; streaming does not change ACC, tool signatures, or approval boundaries.

## Compatibility

- No database migration.
- `/run`, SDKs, tool signatures, and the executor protocol are unchanged.
- New SSE events are backward compatible; old clients may continue to process only terminal results.
- Non-streaming model targets and existing chat entries retain their previous behavior.

## Validation

The release is checked with:

- `npm run typecheck`
- `npm test`
- `npm --prefix web-admin run build`
- `npm run docs:check`
- `npm run release:check`
