# Rich Content Renderers for the Embedded Chat Widget

The BailingHub widget natively renders Markdown text, tables, images, and file links. Charts and interactive reports use a trusted renderer registry. The constrained `bailing-form` v1 renderer is built into the official widget. Both consume declarative fenced payloads while the core widget remains free of third-party runtime dependencies.

## Trust Boundary

- The model emits declarative data only. It cannot supply or select JavaScript, HTML, remote script URLs, or component code.
- Custom renderers are installed and registered by the embedding application and are therefore trusted host code. The built-in `bailing-form` follows the same allowlist and fallback boundary.
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
  mount({ container, payload, source, type, version, theme, signal, message, respond }) {
    // payload is untrusted input; validate fields, counts, and ranges here.
    const chart = createMyChart(container, payload, theme);
    return () => chart.destroy();
  },
});

unregister();
```

`mount` may return a cleanup function, an object with `destroy()`, a Promise, or nothing. Async renderers should stop work when `signal` is aborted.

Widget API v1 adds two optional, backward-compatible context values for an
interactive renderer:

- `message` contains the current assistant message `jobId` and known
  `responses`. Each response summary contains only
  `type/version/source_job_id/form_id/submission_id/action`, never form values.
- `respond(response, presentation?)` returns a Promise and creates the next
  user message in the same thread. A form response is
  `{form_id, submission_id, action:"submit"|"cancel", values?}`;
  `submission_id` matches `[A-Za-z0-9_-]{8,64}` and serialized `values` is at
  most 32 KiB. The widget forces `type:"bailing-form"`, `version:1`, and
  `source_job_id` from the current message closure. A renderer cannot select an
  endpoint, method, or arbitrary source job. The optional `{displayText}`
  presentation is local user-bubble copy and is never sent to the server.

Existing renderers may ignore the new properties, so
`rendererApiVersion === "1"` is unchanged. Neither `message` nor `respond`
exposes the ticket, visitor id, thread id, or other identity material.

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

## Built-in `bailing-form` v1

The official widget advertises and renders `bailing-form` without React, Vue,
a JSON Schema runtime, or a form library. The model emits data only; the widget
owns controls, validation, submission, and receipts.

A host may preload its own `bailing-form` renderer before an asynchronous
widget script to explicitly replace the built-in UI. That trusted host code
must implement this section's complete validation, response, and cleanup
contract. The server still reloads and validates the source reply, so a host
override never relaxes the authoritative boundary.

````markdown
```bailing-form
{
  "version": 1,
  "form_id": "refund_info",
  "title": "Refund information",
  "description": "The conversation will continue after submission",
  "schema": {
    "reason": {
      "type": "textarea",
      "label": "Reason",
      "required": true,
      "maxLength": 200
    },
    "method": {
      "type": "single_select",
      "label": "Refund method",
      "required": true,
      "options": [
        { "label": "Original payment method", "value": "original" },
        { "label": "Account balance", "value": "balance" }
      ]
    }
  },
  "submit_label": "Submit",
  "cancel_label": "Cancel"
}
```
````

Top-level keys are limited to `version:1`, `form_id`, `title`, optional
`description`, `schema`, optional `submit_label`, and optional `cancel_label`.
Form and field ids match `[a-z][a-z0-9_-]{0,63}`. A fenced JSON payload is at
most 32 KiB and contains 1–12 fields. Titles and labels are at most 80
characters, form descriptions 300, field descriptions 200, placeholders 120,
and button labels 32.

| `type` | Additional keys and limits |
|---|---|
| `text` | optional `minLength` / `maxLength`; maximum cap 500 |
| `textarea` | optional `minLength` / `maxLength`; maximum cap 2000 |
| `number` | optional finite numeric `min` / `max` |
| `date` | optional `min` / `max` in fixed `YYYY-MM-DD` format |
| `boolean` | no additional keys |
| `single_select` | required `options`, 1–50 entries, one choice |
| `multi_select` | required `options`, 1–50 entries, multiple choices |

All fields use `label` and may use `description`, `placeholder`, and
`required`. An option contains only `{label,value}`; labels are at most 80
characters, values at most 120, and values are unique within the field.
Unknown keys, nested objects, files, regular expressions, HTML/JavaScript/CSS,
remote scripts/data sources, and values containing triple backticks are
rejected.

### Submission, receipts, and history recovery

1. The form mounts only after the source reply is complete and `done`; the
   source job never enters a waiting state.
2. Submit or cancel posts an `interaction_response` to the original entry. The
   server creates a new job in the same thread and uses the existing SSE flow.
3. Controls are disabled while sending. Once job creation succeeds, the source
   form becomes a read-only Submitted or Cancelled receipt. A failed request
   restores the controls and is not presented as success.
4. A user history message may include an `interaction` summary. The widget uses
   `source_job_id + form_id` to restore replied state after reload or on another
   device, without making the source form submit again.

Forms collect ordinary information or choices. They are not approvals,
authorization credentials, or tool-execution confirmations. Credential- or
payment-like text in the form title/description or a field's name, label,
description, or placeholder is rejected, including passwords, API keys, tokens,
private keys, card numbers, and CVV. Non-secret submitted values become
conversation-ledger and model-context data, so deployments must apply their own
retention and compliance rules.

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
    "renderers": ["bailing-chart", "bailing-form"]
  }
}
```

`client_capabilities` is presentation-only negotiation:

- when it is absent, BailingHub does not assume that the client can render charts;
- declaring `bailing-chart` or `bailing-form` does not change identity, permissions, approval, routing, tool allowlists, or final business authorization;
- do not advertise a renderer that the client has not installed; the server accepts at most 16 valid type names;
- a capable client does not require a chart in every answer, and missing data must never be fabricated to produce one.

After creating the job, connect to `GET /chat/:entry_key/events/:job_id` and follow this lifecycle:

1. append `delta` events to a provisional text bubble without mounting rich content;
2. discard the provisional buffer and render state on `reset`;
3. replace the provisional bubble with the authoritative `done.reply`;
4. only after `done`, parse complete fenced blocks with a mature Markdown parser and dispatch allowlisted types to trusted renderers; retain that `done.job_id` as the form `source_job_id`;
5. never present provisional text from `failed` or `timeout` as a final business result.

See [`docs/examples/custom-streaming-chat-client.mjs`](examples/custom-streaming-chat-client.mjs) for the transport lifecycle. It intentionally omits a Markdown parser and chart library. Integrators should consume fenced-code AST/tokens from their existing Markdown parser rather than interpreting model output with `eval`, `innerHTML`, or remote scripts.

To submit a form, a custom client posts
`{interaction_response:{type:"bailing-form",version:1,source_job_id,form_id,submission_id,action,values?}, visitor_id?, ticket?, thread_id?}`
to the same `POST /chat/:entry_key`. The server checks the source
job/entry/identity/thread, reloads the authoritative schema, validates values,
and deduplicates by `submission_id`. Do not send `message` in the same request
or send a client-side schema as authority. See
[CONTRACT.en.md](CONTRACT.en.md#non-blocking-bailing-form-responses).

### Minimum Requirements for a Custom Renderer

- match the type against a local allowlist such as `bailing-chart`;
- accept only an object or array and cap bytes, nesting depth, string length, and point count;
- validate enums and finite numeric values, for example `kind` in `bar/line/pie`;
- fall back to plain text or a code block on unknown types, invalid JSON, limits, or renderer errors;
- destroy chart instances and listeners when the final message is replaced, the route changes, or the component unmounts;
- keep attachments, references, charts, and business execution results as separate contracts.
- for `bailing-form`, implement this document's field allowlist, range checks,
  unique submission id, failure recovery, and history receipt; never pass an
  arbitrary JSON Schema directly into a dynamic form runtime.

In short: the official widget is the batteries-included path. A custom client owns capability advertisement, SSE lifecycle handling, final-reply parsing, and trusted rendering; BailingHub does not silently assume those host responsibilities.
