# BailingHub v0.1.14: Trusted Rich Rendering and Chat Reliability

`v0.1.14` improves perceived latency, structured presentation, and runtime convergence for business-facing chat. The official widget remains dependency-free. Charts and other rich content are registered explicitly by the host as trusted renderers, while model output remains constrained declarative data.

## User-visible results

- Streaming replies may show a provisional progress bubble. The authoritative final reply replaces it instead of leaving duplicate messages in the conversation.
- A host can register trusted renderers with the official widget. The chat window can expand for wide tables or charts, and users can maximize and restore it.
- Safe Markdown tables remain built in. Charts use declarative fenced payloads; unknown types, invalid JSON, excessive data, or renderer errors fall back to a normal code block.
- BailingHub presents an optional rendering capability to the model only when the client explicitly advertises a renderer it actually supports. The model may still choose text or a table when that better matches the real data.

## Custom chat clients

A frontend that does not load the official `widget.js` owns four responsibilities:

1. advertise only installed and trusted renderer types through `client_capabilities.renderers` when creating the job;
2. treat `delta` as provisional text and discard it on `reset`;
3. replace the provisional bubble with `done.reply`, the only authoritative final text;
4. parse complete fenced blocks with a mature Markdown parser only after `done`, then dispatch allowlisted types to local trusted renderers.

`client_capabilities` is presentation-only negotiation. It does not change identity, routing, tool allowlists, approval, or final business authorization. See [`examples/custom-streaming-chat-client.mjs`](examples/custom-streaming-chat-client.mjs) for a minimal transport example.

## Runtime reliability

- Additional tool discovery has an independent limit and stops early when no new tools are found, preventing unbounded model rounds caused by paraphrased searches.
- HTTP error pages from tools are reduced to compact model-facing summaries. The full response remains available to the audit path under its independent size limit.
- LLM traces add low-sensitivity measurements such as request size, tool count, reasoning characters, first-token latency, and total duration without recording secrets or business payloads.

## Compatibility and security boundary

- No database migration is required.
- ACC, the Client API version, executor protocol, tool signatures, approval semantics, and business authorization are unchanged.
- Existing clients that omit `client_capabilities` continue receiving ordinary Markdown. Unknown rich-content types degrade safely.
- The core widget does not bundle ECharts, GPT-Vis, Mermaid, or another chart library, and it never executes model-generated HTML, JavaScript, event handlers, or remote scripts.

## Validation

```bash
npm run release:check
```

Focused coverage includes renderer registration, failure fallback, cleanup lifecycle, capability negotiation, provisional-message replacement, and syntax validation for the custom-client example.

## Related documentation

- [Trusted rich-content renderers](WIDGET_RENDERERS.en.md)
- [Streaming chat contract](STREAMING.md)
- [Third-party integration](INTEGRATION.en.md)
- [Compatibility and upgrades](COMPATIBILITY.en.md)
- [中文发布说明](RELEASE_NOTES_v0.1.14.md)
