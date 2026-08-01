# Rich Content Renderers for the Embedded Chat Widget

The BailingHub widget natively renders Markdown text, tables, images, and file links. Charts and interactive reports use an optional trusted renderer registry, keeping the core widget free of third-party runtime dependencies.

## Trust Boundary

- The model emits declarative data only. It cannot supply or select JavaScript, HTML, remote script URLs, or component code.
- Renderers are installed and registered by the embedding application and are therefore trusted host code.
- A renderer never receives chat tickets, business credentials, acting-subject identity, or full page context.
- Unknown types, invalid JSON, oversized payloads, and renderer failures fall back to a code block rendered through `textContent`.
- Rich content mounts only after a complete, closed fenced code block arrives. Incremental streaming output does not repeatedly create charts.
- Message replacement, history reload, and conversation restart abort active work and call renderer cleanup functions.

This API does not grant frontend execution authority to the model. It lets the model submit data to a fixed host-controlled allowlist.

## Registration API

The current renderer API is `window.BailingChat.rendererApiVersion === "1"`.

```js
const unregister = window.BailingChat.registerRenderer({
  type: 'bailing-chart',
  version: 1,
  label: 'Business chart',
  contentType: 'application/json', // or text/plain
  maxPayloadBytes: 64 * 1024,
  mount({ container, payload, source, type, version, theme, signal }) {
    // payload is untrusted input; validate fields, counts, and ranges here.
    const chart = createMyChart(container, payload, theme);
    return () => chart.destroy();
  },
});

unregister();
```

`mount` may return a cleanup function, an object with `destroy()`, a Promise, or nothing. Async renderers should stop work when `signal` is aborted.

## Reply Format

After `bailing-chart` is registered, a complete reply can include:

````markdown
```bailing-chart
{
  "kind": "bar",
  "title": "Revenue for the last seven days",
  "data": [
    { "label": "Mon", "value": 12800 },
    { "label": "Tue", "value": 15300 }
  ]
}
```
````

Type names start with a lowercase letter and contain only letters, numbers, dots, underscores, plus signs, and hyphens, up to 64 characters. JSON renderers accept objects or arrays; scalar payloads should use `text/plain`.

## Loading Order

Register after the widget loads:

```html
<script src="https://hub.example.com/widget.js" data-entry="store_assistant"></script>
<script type="module">
  import { registerBailingChartRenderer } from './widget-chart-renderer-adapter.mjs';
  registerBailingChartRenderer(createChart);
</script>
```

Or preload definitions before an async widget script:

```html
<script>
  window.BailingChat = {
    renderers: [{
      type: 'bailing-chart',
      mount(context) { return mountTrustedChart(context); }
    }]
  };
</script>
<script async src="https://hub.example.com/widget.js" data-entry="store_assistant"></script>
```

## Chart Libraries

ECharts, GPT-Vis, Mermaid, and internal report components belong in host adapters rather than the BailingHub core. An adapter must validate the declaration, constrain data size, reject arbitrary HTML/scripts/event handlers/data sources, and release resources on abort or destroy.

Start with [`docs/examples/widget-chart-renderer-adapter.mjs`](examples/widget-chart-renderer-adapter.mjs).

## Custom Streaming Clients (Without widget.js)

A client that consumes the chat API and SSE directly does not inherit the official widget's rendering behavior. It must declare only renderer types that it has installed, validated, and chosen to trust:

```http
POST /chat/store_assistant
Content-Type: application/json

{
  "message": "Analyze revenue for the last seven days",
  "visitor_id": "visitor_01HXYZ",
  "client_capabilities": {
    "renderers": ["bailing-chart"]
  }
}
```

`client_capabilities` is presentation-only negotiation:

- when it is absent, BailingHub does not assume that the client can render charts;
- declaring `bailing-chart` does not change identity, permissions, approval, routing, tool allowlists, or final business authorization;
- do not advertise a renderer that the client has not installed; the server accepts at most 16 valid type names;
- a capable client does not require a chart in every answer, and missing data must never be fabricated to produce one.

After creating the job, connect to `GET /chat/:entry_key/events/:job_id` and follow this lifecycle:

1. append `delta` events to a provisional text bubble without mounting rich content;
2. discard the provisional buffer and render state on `reset`;
3. replace the provisional bubble with the authoritative `done.reply`;
4. only after `done`, parse complete fenced blocks with a mature Markdown parser and dispatch allowlisted types to trusted renderers;
5. never present provisional text from `failed` or `timeout` as a final business result.

See [`docs/examples/custom-streaming-chat-client.mjs`](examples/custom-streaming-chat-client.mjs) for the transport lifecycle. It intentionally omits a Markdown parser and chart library. Integrators should consume fenced-code AST/tokens from their existing Markdown parser rather than interpreting model output with `eval`, `innerHTML`, or remote scripts.

### Minimum Requirements for a Custom Renderer

- match the type against a local allowlist such as `bailing-chart`;
- accept only an object or array and cap bytes, nesting depth, string length, and point count;
- validate enums and finite numeric values, for example `kind` in `bar/line/pie`;
- fall back to plain text or a code block on unknown types, invalid JSON, limits, or renderer errors;
- destroy chart instances and listeners when the final message is replaced, the route changes, or the component unmounts;
- keep attachments, references, charts, and business execution results as separate contracts.

In short: the official widget is the batteries-included path. A custom client owns capability advertisement, SSE lifecycle handling, final-reply parsing, and trusted rendering; BailingHub does not silently assume those host responsibilities.
