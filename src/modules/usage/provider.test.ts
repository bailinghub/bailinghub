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
