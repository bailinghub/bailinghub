# BailingHub v0.1.14: Transient Progress Feedback for Streaming Chat

`v0.1.14` improves the waiting experience in the official web chat widget when a governed action needs a tool call. A short model acknowledgement remains visible as transient progress while the business result is pending. As soon as the formal answer starts streaming, the transient bubble disappears and only the final answer remains in chat history.

## User-visible behavior

- A short pre-tool acknowledgement no longer flashes and disappears immediately; it is promoted into a transient progress bubble.
- Tool execution, model synthesis, retry, and fallback phases show explicit status copy.
- The progress bubble is removed when the formal streamed answer begins, so the conversation does not retain two assistant messages.
- Failed and background-processing outcomes use deterministic status copy without implying that a business operation succeeded.
- Progress animation respects the operating system's reduced-motion preference.

## Semantic boundary

This feature is not a reasoning trace and does not expose or retain hidden chain-of-thought. The widget presents only:

- acknowledgement text that the model already emitted;
- `reset` and `phase` states already exposed by the BailingHub stream;
- the formal final answer.

Transient copy is whitespace-normalized and length-bounded. Only the formal answer enters chat history; progress remains local UI state for the active stream.

## Custom chat UIs

The official `web/widget/widget.js` adopts the behavior automatically. Integrations that do not use the official widget do not need a BailingHub API change, but must consume the existing stream events to reproduce the experience:

- `delta`: accumulate the current model text;
- `reset`: promote prior short text into transient progress and clear the formal-answer buffer;
- `phase`: update the tool or model phase;
- `done`: remove transient progress and persist only the final answer.

Custom clients should not retain progress and the final answer as two permanent assistant messages.

## Compatibility

- No database migration is required.
- Client API and streaming event protocol are unchanged.
- Executor protocol, tool signatures, approval semantics, audit boundaries, and ACC are unchanged.
- Existing custom chat UIs retain their current behavior; the official widget gains the new experience when upgraded.

## Validation

```bash
node --check web/widget/widget.js
node --import tsx --test src/routes/public.test.ts
npm run typecheck
npm run release:check
```

## Related docs

- [Public runtime contract](CONTRACT.en.md)
- [Independent validation task](INDEPENDENT_VALIDATION.en.md)
- [Compatibility and upgrades](COMPATIBILITY.en.md)
- [中文发布说明](RELEASE_NOTES_v0.1.14.md)
