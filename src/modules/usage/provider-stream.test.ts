import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviderExchange } from './provider-stream';
import { normalizeModelRequest, providerBody } from './provider';
import type { UsageServiceConfig } from './contracts';

const config: UsageServiceConfig = { credential: 'synthetic', model: 'synthetic', providerScope: 'synthetic',
  maxInputBytes: 1048576, maxOutputTokens: 2048, timeoutMs: 60000 };
const request = { operation_id: 'op', messages: [{ role: 'user', content: 'synthetic' }] };
const event = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`;
const stream = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });

test('transport forwards every provider field and UTF8 fragment before completion', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream({ start(c) { source = c; } }), { headers: { 'content-type': 'text/event-stream' } });
  const packets: Record<string, unknown>[] = []; let first!: () => void;
  const preview = new Promise<void>(resolve => { first = resolve; });
  const result = readProviderExchange(response, async packet => { packets.push(packet); first(); });
  const head = event({ id: 'synthetic', choices: [{ index: 0, delta: { content: '你好', reasoning: { extension: true }, tool_calls: null }, finish_reason: 'provider_specific' }], extension: { a: 1 } });
  for (const byte of new TextEncoder().encode(head)) source.enqueue(Uint8Array.of(byte));
  await preview;
  const tail = event({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + 'data: [DONE]\r\n\r\n';
  source.enqueue(new TextEncoder().encode(tail)); source.close();
  const completed = await result;
  assert.equal(packets.map(packet => packet.data).join(''), head + tail);
  assert.equal(completed.response.body, head + tail);
  assert.deepEqual(completed.usage, { inputTokens: 10, outputTokens: 2 });
});

test('provider semantics are preserved for local parsing, never rejected by the meter', async () => {
  const bodies = [
    event({ choices: [{ delta: { content: '', tool_calls: [] }, finish_reason: 'content_filter' }] }),
    event({ id: 'first', choices: [] }) + event({ id: 'second', choices: [] }),
    event({ choices: [{ index: 4, delta: { tool_calls: [{ index: 9, type: 'extension', function: { arguments: {} } }] }, finish_reason: 'custom' }] }),
    'data: malformed-json\n\n',
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
  ];
  for (const body of bodies) {
    const result = await readProviderExchange(stream(body));
    assert.equal(result.response.body, body);
    assert.equal(result.usage, undefined);
  }
});

test('JSON and HTTP error responses keep native body/status; metering is independent', async () => {
  for (const status of [200, 400, 401, 404, 429, 503]) {
    const body = JSON.stringify({ unknown: 'extension', choices: [], error: { type: 'synthetic_error' }, usage: { total_tokens: 123 } });
    const result = await readProviderExchange(new Response(body, { status }));
    assert.equal(result.response.body, body); assert.equal(result.response.status, status);
    assert.equal(result.usage, undefined);
  }
  const text = '{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}';
  assert.deepEqual((await readProviderExchange(new Response(text))).usage, { inputTokens: 5, outputTokens: 2 });
});

test('conflicting usage or execution identity cannot fabricate financial evidence', async () => {
  const body = event({ id: 'one', usage: { prompt_tokens: 1, completion_tokens: 2 } })
    + event({ id: 'two', usage: { prompt_tokens: 1, completion_tokens: 2 } });
  const result = await readProviderExchange(stream(body));
  assert.equal(result.response.body, body); assert.equal(result.executionId, null); assert.equal(result.usage, undefined);
});

test('actual transport loss and byte bound remain errors without exposing response content', async () => {
  const broken = new Response(new ReadableStream({ start(c) { c.error(new Error('synthetic transport loss')); } }));
  await assert.rejects(readProviderExchange(broken), /synthetic transport loss/);
  await assert.rejects(readProviderExchange(new Response('x'.repeat(4 * 1024 * 1024 + 1))), { code: 'USAGE_PROVIDER_RESPONSE_TOO_LARGE' });
  const signal = AbortSignal.abort();
  await assert.rejects(readProviderExchange(stream(event({ choices: [] })), undefined, signal));
});

test('large legitimate context and model options are preserved, exceeding the service limit reports exact counts', () => {
  const input = normalizeModelRequest({ ...request, messages: [{ role: 'user', content: 'x'.repeat(300000) }],
    provider_options: { top_p: 0.5, response_format: { type: 'json_object' }, max_tokens: 1000 } });
  const body = providerBody(input, config, true);
  assert.equal(body.stream, true); assert.equal(body.top_p, 0.5); assert.equal(body.max_tokens, 1000);
  assert.deepEqual(body.messages, input.messages);
  assert.throws(() => providerBody(input, { ...config, maxInputBytes: 262144 }, true), (error: any) => {
    assert.equal(error.code, 'USAGE_INPUT_LIMIT');
    assert.equal(error.details.input_limit.actual, Buffer.byteLength(JSON.stringify(body)));
    assert.equal(error.details.input_limit.allowed, 262144); assert.equal(error.details.input_limit.message_count, 1); return true;
  });
  for (const provider_options of [{ model: 'other' }, { api_key: 'not-allowed' }, { stream: false }, { messages: [] }])
    assert.throws(() => normalizeModelRequest({ ...request, provider_options }));
  assert.throws(() => providerBody({ ...request, provider_options: { max_tokens: 9000 } }, config), { code: 'USAGE_OUTPUT_LIMIT' });
});
