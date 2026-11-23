import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { executeProvider, canonicalJson, normalizeModelRequest, providerBody, verifiedUsage } from './provider';
import type { UsageServiceConfig } from './contracts';

const config: UsageServiceConfig = {
  credential: 'synthetic', model: 'synthetic-text', providerScope: 'test-provider', maxInputBytes: 16384,
  maxOutputTokens: 100, timeoutMs: 1000,

};
const input = { operation_id: 'operation-1', messages: [{ role: 'user', content: 'Show product availability.' }] };

test('gateway preserves supported content parts without accepting caller-selected model or credentials', () => {
  for (const field of ['model', 'base_url', 'api_key', 'usage', 'account_id', 'stream', 'max_tokens']) {
    assert.throws(() => normalizeModelRequest({ ...input, [field]: 'untrusted' }), /not supported/);
  }
  const image = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image' } }] }];
  assert.deepEqual(normalizeModelRequest({ ...input, messages: image }).messages, image);
  assert.throws(() => normalizeModelRequest({ ...input, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///private/image' } }] }] }), /Only text/);
  assert.throws(() => normalizeModelRequest({ ...input, tools: [{ type: 'web_search' }] }), /function/);
  const normalized = normalizeModelRequest(input);
  assert.equal(providerBody(normalized, config).max_tokens, 100);
  assert.throws(() => providerBody(normalized, { ...config, maxInputBytes: 2 }), { code: 'USAGE_INPUT_LIMIT' });
});

test('original operation hash ignores object key order but preserves every message and tool parameter', () => {
  const first = normalizeModelRequest(input);
  const second = normalizeModelRequest({ messages: [{ content: 'Show product availability.', role: 'user' }], operation_id: 'operation-1' });
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.notEqual(canonicalJson(first), canonicalJson({ ...first, messages: [{ role: 'user', content: 'Update product availability.' }] }));
});

test('usage preserves unknown and does not add cached or reasoning subsets twice', () => {
  assert.equal(verifiedUsage(undefined), undefined);
  assert.equal(verifiedUsage({ total_tokens: 0 }), undefined);
  assert.equal(verifiedUsage({ prompt_tokens: -1, completion_tokens: 2 }), undefined);
  assert.equal(verifiedUsage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 9 }), undefined);
  assert.deepEqual(verifiedUsage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 1 } }), { inputTokens: 5, outputTokens: 2 });
});

test('only a recognized TokenHub context rejection gets a safe receipt diagnostic', async () => {
  const base = 'https://tokenhub.tencentmaas.com/v1';
  const raw = JSON.stringify({ error: { code: '400003', message: 'private input detail', request_id: 'private-id',
    context_window_tokens: 17 }, diagnostic: { code: 'supplied-by-provider' } });
  const check = async (baseUrl: string, status: number, responseBody: string, window?: number, streaming = false) => {
    const configSnapshot = { ...config, contextWindowTokens: window };
    const packets: Record<string, unknown>[] = [];
    let calls = 0;
    const result = await executeProvider({ base_url: baseUrl, api_key: 'synthetic' }, configSnapshot,
      providerBody(input, configSnapshot, streaming), async (_url, init) => {
        calls++;
        assert.equal(JSON.parse(String(init?.body)).stream, streaming);
        assert.equal(init?.redirect, 'error');
        return new Response(responseBody, { status, headers: { 'content-type': 'application/json' } });
      }, streaming ? async packet => { packets.push(packet); } : undefined);
    assert.equal(result.response.body, responseBody);
    assert.equal(result.response.status, status);
    assert.equal(calls, 1);
    if (streaming) assert.equal(packets.map(packet => packet.data).join(''), responseBody);
    return result.response.diagnostic;
  };
  const expected = { code: 'CONTEXT_WINDOW_EXCEEDED', http_status: 400, provider_code: '400003' };
  for (const streaming of [false, true]) {
    assert.deepEqual(await check(base, 400, raw, 1048576, streaming), { ...expected, context_window_tokens: 1048576 });
  }
  for (const missingOrInvalid of [undefined, 0, -5, 1.5, 10_000_001]) {
    assert.deepEqual(await check(base, 400, raw, missingOrInvalid), expected);
  }
  assert.deepEqual(await check('https://TOKENHUB.tencentmaas.com:443/v1/', 400, '{"error":{"code":400003}}'), expected);
  for (const otherRoute of ['https://other.invalid/v1', 'https://tokenhub.tencentmaas.com.other.invalid/v1',
    'http://tokenhub.tencentmaas.com/v1', 'https://tokenhub.tencentmaas.com:8443/v1', base + '/another']) {
    assert.equal(await check(otherRoute, 400, raw), undefined);
  }
  for (const status of [200, 413, 429, 500]) assert.equal(await check(base, status, raw), undefined);
  for (const otherBody of ['{', 'null', '{"error":{"code":"400001","message":"CodeInputTooLong 400003"}}',
    '{"code":"400003"}', '{"error":{"code":"4000030"}}']) {
    assert.equal(await check(base, 400, otherBody), undefined);
  }
});

test('real HTTP provider receives only the service output bound, no automatic retry', async () => {
  let modelCalls = 0; const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/count-input') { res.end(JSON.stringify({ input_tokens: 20 })); return; }
    modelCalls++; res.writeHead(503); res.end(JSON.stringify({ message: 'synthetic transport failure' }));
  }).listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const credential = { base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api_key: 'synthetic-test-only' };
    const body = providerBody(normalizeModelRequest(input), config);
    const result = await executeProvider(credential, config, body);
    assert.equal(result.response.status, 503);
    assert.deepEqual(JSON.parse(result.response.body as string), { message: 'synthetic transport failure' });
    assert.equal(result.usage, undefined);
    assert.equal(modelCalls, 1);
    assert.equal(bodies[0]?.max_tokens, 100);
    assert.equal(bodies[0]?.model, 'synthetic-text');
    assert.equal(bodies[0]?.account_id, undefined);
    assert.equal(modelCalls, 1, 'absolute-origin tokenizer paths must not become /v1/v1/count-input');
    assert.equal(modelCalls, 1);
  } finally { server.close(); await once(server, 'close'); }
});
