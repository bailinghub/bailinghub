import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '../../app/auth';
import { handleAdminApiFor, type AdminApiDeps } from '../../routes/admin';
import { providerModelContext } from './model-context';

const missing = { context_window_tokens: null, source_url: null };
const tokenHub = { base_url: 'https://tokenhub.tencentmaas.com/v1', api_key: 'test-token' };
const flash = 'deepseek/deepseek-flash';

test('TokenHub matches only its exact documented route and invocation model without network I/O', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('unexpected network'); };
  const result = await providerModelContext(tokenHub, flash, fetcher);
  assert.deepEqual(result, { context_window_tokens: 1048576, source_url: 'https://cloud.tencent.com/document/product/1823/130051' });
  for (const model of ['deepseek/deepseek-v4.1-flash', 'unknown', 'DeepSeek/deepseek-flash']) {
    assert.deepEqual(await providerModelContext(tokenHub, model, fetcher), missing);
  }
  for (const base_url of ['http://tokenhub.tencentmaas.com/v1', 'https://tokenhub.tencentmaas.com.example/v1',
    'https://api.deepseek.com.example/v1', 'https://openrouter.ai:444/api/v1', 'https://api.deepseek.com/proxy',
    'https://user@api.deepseek.com', 'https://api.deepseek.com/v1?redirect=x', 'http://127.0.0.1:8080/v1', 'bad']) {
    assert.deepEqual(await providerModelContext({ ...tokenHub, base_url }, flash, fetcher), missing);
  }
  assert.equal(calls, 0);
});

test('Beijing Model Studio offers the published combined window for its exact Qwen invocation', async () => {
  const beijing = { ...tokenHub, base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' };
  let requests = 0;
  const fetcher = async () => { requests++; throw new Error('unexpected network'); };
  assert.deepEqual(await providerModelContext(beijing, 'qwen3.8-max', fetcher), {
    context_window_tokens: 1000000, source_url: 'https://help.aliyun.com/zh/model-studio/qwen3-8-max' });
  assert.deepEqual(await providerModelContext(beijing, 'qwen/qwen3.8-max-prime', fetcher), missing);
  assert.deepEqual(await providerModelContext({ ...beijing, base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }, 'qwen3.8-max', fetcher), missing);
  assert.deepEqual(await providerModelContext(tokenHub, 'qwen3.8-max', fetcher), missing);
  assert.equal(requests, 0);
});

test('DeepSeek reads authenticated official metadata and filters one exact model and a bounded combined capacity', async () => {
  const credential = { ...tokenHub, base_url: 'https://api.deepseek.com/v1/' };
  const row = { object: 'model', id: 'selected', context_window: 1048576, max_output_tokens: 768 };
  const inspect = (rows: unknown[], status = 200) => providerModelContext(credential, 'selected', async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/models');
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
    return Response.json({ object: 'list', data: rows, secret: credential.api_key }, { status });
  });
  assert.deepEqual(await inspect([row, { ...row, id: 'other', context_window: 5 }]), {
    context_window_tokens: 1048576, source_url: 'https://api-docs.deepseek.com/zh-cn/api/list-models/' });
  for (const n of [undefined, null, 0, -1, 1.5, '1048576', 10_000_001]) assert.deepEqual(await inspect([{ ...row, context_window: n }]), missing);
  assert.deepEqual(await inspect([row, row]), missing);
  assert.deepEqual(await inspect([{ ...row, id: 'other' }]), missing);
  assert.deepEqual(await inspect([row], 401), missing);
  assert.deepEqual(await providerModelContext(credential, 'selected', async () => { throw new Error('failed'); }), missing);
  assert.deepEqual(await providerModelContext(credential, 'selected', async () => new Response('{')), missing);
  assert.deepEqual(await providerModelContext(credential, 'selected', async () => new Response('x'.repeat(524289))), missing);
});

test('OpenRouter reports a shared endpoint window only for the exact model and never forwards the service key', async () => {
  const credential = { ...tokenHub, base_url: 'https://openrouter.ai/api/v1' };
  const model = 'synthetic/model-v1', endpoint = { model_id: model, context_length: 131072 };
  const read = (endpoints: unknown[], id = model) => providerModelContext(credential, model, async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/models/synthetic/model-v1/endpoints');
    assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).has('authorization'), false);
    return Response.json({ data: { id, context_length: 999999, endpoints } });
  });
  assert.equal((await read([endpoint, endpoint])).context_window_tokens, 131072);
  for (const endpoints of [[], [null], [endpoint, { ...endpoint, context_length: 20000 }], [{ ...endpoint, model_id: 'different' }]]) {
    assert.deepEqual(await read(endpoints), missing);
  }
  assert.deepEqual(await read([endpoint], 'another/model'), missing);
  let calls = 0;
  for (const bad of ['../secret', 'foo/..', 'a/b/other', 'a/model?x=1']) {
    assert.deepEqual(await providerModelContext(credential, bad, async () => { calls++; return new Response(); }), missing);
  }
  assert.equal(calls, 0);
});

test('admin endpoint requires service management and only reads credential metadata', async () => {
  const reads: string[] = [];
  const touches: string[] = [];
  const deps = { cfg: { llmCredentials: { configured: tokenHub } }, configStore: { usage: {}, credentials: {
    get: async (id: string) => { reads.push(id); return id === 'db' ? { ...tokenHub, enabled: true, kind: 'chat' } : null; },
    touch: async (id: string) => { touches.push(id); },
  } } } as unknown as AdminApiDeps;
  const admin: Principal = { kind: 'admin', via: 'token' };
  const path = '/admin/api/usage/model-context';
  async function request(query: string, principal = admin, method = 'GET') {
    let status = 0, body;
    const res = { writeHead(code: number) { status = code; }, end(value: string) { body = JSON.parse(value); } };
    await handleAdminApiFor(deps, method, path, { url: path + '?' + query } as IncomingMessage, res as unknown as ServerResponse, principal);
    return { status, body };
  }
  const qs = 'credential=db&model=deepseek%2Fdeepseek-flash';
  assert.equal((await request(qs, { kind: 'admin', via: 'session', role: 'usage_auditor' })).status, 403);
  assert.equal((await request(qs, { kind: 'admin', via: 'session', role: 'usage_operator' })).status, 403);
  assert.equal((await request(qs, admin, 'POST')).status, 405);
  assert.equal((await request('model=x')).status, 400);
  const fromFile = await request(qs.replace('=db', '=configured'));
  assert.deepEqual(reads, []); assert.equal(fromFile.status, 200);
  assert.deepEqual((await request(qs)), fromFile);
  assert.deepEqual(Object.keys(fromFile.body!).sort(), ['context_window_tokens', 'source_url']);
  assert.deepEqual((await request(qs.replace('=db', '=constructor'))).body, missing);
  assert.deepEqual(reads, ['db', 'constructor']); assert.deepEqual(touches, []);
});
