# Embedded Chat Streaming Protocol

> Protocol identifier: `bailing.chat.stream.v1`

This document defines incremental output, reconnect replay, fallback, and persistence boundaries for the BailingHub embedded chat widget. A `delta` is a text fragment emitted by the model provider. It is not guaranteed to correspond to exactly one tokenizer token.

## 1. Boundaries

- Incremental text is provisional UI transport data.
- The terminal job record is the single source of truth, and `done` is always built from that record.
- Conversation history, webhook callbacks, channel delivery, references, and attachments consume the terminal result, not fragments.
- Audit may record chunk count, character count, first-fragment latency, and finish reason, but never writes every fragment body.
- Tool calls, retries, and provider fallback may start a new model round. Clients must honor `reset` and must not concatenate provisional text from different rounds.

## 2. Connection Flow

1. Create a job with `POST /chat/:entry_key` and read `job_id`.
2. Connect to `GET /chat/:entry_key/events/:job_id` with `EventSource`.
3. Consume base status events and any incremental events.
4. On `done`, replace provisional output with `reply`, then persist local history and render references or attachments.
5. On a transient disconnect, standard `EventSource` reconnects with `Last-Event-ID`.

## 3. Events

| Event | Key fields | Client behavior |
|---|---|---|
| `open` | `job_id`, `status`, `protocol`, `streaming` | Confirms the connection. `streaming:true` means this replica has an incremental relay; it does not guarantee the provider will emit fragments. |
| `status` | `job_id`, `status` | Optionally show `queued`, `running`, or `dispatched`. |
| `phase` | `seq`, `ts`, `name`, `round` | `name` is `model` or `tool`. This is informative, not terminal evidence. |
| `reset` | `seq?`, `reason`, `round?`, `latest_seq?` | Immediately discard provisional text. |
| `delta` | `seq`, `ts`, `text`, `round` | Append `text` to the current provisional answer. |
| `ping` | `ts`, `job_id` | Keepalive only. |
| `done` | `done`, `reply`, `job_id`, `visitor_id`, `references?`, `attachments?`, `error?` | Canonical terminal result. Replace provisional text and close. |
| `failed` | `done`, `error`, `reply` | The connection can no longer read the job. |
| `timeout` | `done:false`, `job_id` | This connection window ended; the job may still complete and can be recovered from history. |

Current `reset.reason` values are `model_round`, `tool_call`, `retry`, `fallback`, and `replay_gap`.

## 4. Event IDs And Replay

- `phase`, broker-backed `reset`, and `delta` use a monotonic per-job `seq` starting at 1. SSE `id` equals `seq`.
- Ignore duplicate events where `seq <= last_seq`.
- Replay is bounded and short-lived; it is not a durable event log.
- If the cursor predates the replay window, the server sends `reset` with `reason: replay_gap` and continues from the earliest available event.

## 5. Provider Fallback

- The `llm` adapter sends `stream:true` only when the current invocation has an incremental consumer.
- Set `target_config.streaming` to `false` to opt out.
- If a provider ignores `stream:true` and returns JSON, BailingHub consumes it as a normal non-streaming completion.
- BailingHub retries once with `stream:false` only for HTTP 400, 404, 415, 422, or 501 responses that explicitly say streaming is unsupported.
- Timeouts, rate limits, 5xx responses, and ambiguous 4xx responses are not replayed merely to attempt fallback. This avoids duplicate work and tool side effects.

## 6. Multi-Replica Operations

The default `InMemoryJobStreamBroker` is process-local. A multi-replica deployment must either use sticky routing for the same `job_id` or inject a shared `JobStreamBroker` at composition time. The canonical final job remains in MySQL, so `done` does not depend on fragment replay.

Reverse proxies and CDNs must disable response buffering, preserve `text/event-stream`, keep read timeouts above the chat window, and allow `Last-Event-ID`.

## 7. Compatibility

- This is an optional event extension under Widget API v1. The `done` payload is unchanged.
- Existing clients may ignore `phase`, `reset`, and `delta` and wait for `done`.
- New clients must treat `done`, not accumulated fragments, as the final authoritative value.

## 8. Validation

```bash
npm run typecheck
node --import tsx --test \
  src/adapters/llm/openai-chat-stream.test.ts \
  src/adapters/targets/llm.test.ts \
  src/core/runtime/job-stream.test.ts \
  src/routes/chat.test.ts \
  src/routes/public.test.ts
```

Before release, also run `npm test`, the admin console build, and `npm run docs:check`.
