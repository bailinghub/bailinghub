import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmAdapter } from './llm';
import type { AdapterContext } from '../../core/targets/adapter';

async function withMockFetch<T>(responses: Array<Record<string, unknown>>, fn: () => Promise<T>): Promise<T> {
  const old = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async () => {
    const body = responses[i++] ?? responses[responses.length - 1] ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = old;
  }
}

async function withFetchImplementation<T>(implementation: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const old = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await fn();
  } finally {
    globalThis.fetch = old;
  }
}

function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${event === '[DONE]' ? '[DONE]' : JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

function baseCtx(): AdapterContext {
  return {
    requestId: 'req-1',
    input: '看看支付方式有哪些',
    userQuery: '看看支付方式有哪些',
    metadata: {},
    source: 'chat:test',
    route: null,
    targetConfig: { credential: 'main', model: 'qwen' },
    session: { sessionId: 's-1', isContinue: false },
    profileName: 'default',
    projectPath: null,
    cfg: {
      llmCredentials: { main: { base_url: 'https://llm.example.com/v1', api_key: 'sk', default_model: 'qwen' } },
    } as unknown as AdapterContext['cfg'],
  };
}

test('llmAdapter: 工具失败后模型空响应时给用户可读兜底', async () => {
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  let invokes = 0;
  const ctx = baseCtx();
  ctx.audit = (event, detail) => { audits.push({ event, detail }); };
  ctx.tools = {
    llmTools: [{
      type: 'function',
      function: {
        name: 'payment_method_list',
        description: '获取支付方式列表',
        parameters: { type: 'object', properties: {} },
      },
    }],
    maxCalls: 5,
    progressive: false,
    retrievalMode: false,
    catalog: [],
    async lookup() { return []; },
    async invoke() {
      invokes++;
      return { ok: false, status: 404, text: '业务接口返回 404' };
    },
  };

  const got = await withMockFetch([
    { choices: [{ message: { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'payment_method_list', arguments: '{}' } }] } }] },
    { choices: [{ message: { content: '' } }] },
    { choices: [{ message: { content: '' } }] },
  ], () => llmAdapter.run(ctx));

  assert.equal(invokes, 1);
  assert.equal(got.ok, true);
  assert.match(String(got.output['text']), /查询时没有拿到可用结果/);
  assert.equal(audits.some((a) => a.event === 'llm_empty_response_retry'), true);
  assert.equal(audits.some((a) => a.event === 'llm_empty_response_fallback'), true);
});

test('llmAdapter: 聊天链路默认请求流式输出，增量事件不进审计正文', async () => {
  const ctx = baseCtx();
  const streamEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const requests: Array<Record<string, unknown>> = [];
  ctx.stream = (event) => { streamEvents.push(event); };
  ctx.audit = (event, detail) => { audits.push({ event, detail }); };

  const got = await withFetchImplementation((async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return sseResponse([
      { choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { content: '你好' } }] },
      { choices: [{ delta: { content: '，世界' }, finish_reason: 'stop' }] },
      { choices: [], usage: { total_tokens: 9 } },
      '[DONE]',
    ]);
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.['stream'], true);
  assert.equal(got.ok, true);
  assert.equal(got.output['text'], '你好，世界');
  assert.equal(got.usage?.tokens, 9);
  assert.deepEqual(streamEvents.map((event) => event.type), ['reset', 'phase', 'delta', 'delta']);
  assert.deepEqual(streamEvents.filter((event) => event.type === 'delta').map((event) => event.data['text']), ['你好', '，世界']);
  const completed = audits.find((audit) => audit.event === 'llm_stream_completed');
  assert.equal(completed?.detail['content_chars'], 5);
  assert.equal('text' in (completed?.detail ?? {}), false);
  assert.equal(JSON.stringify(audits).includes('你好，世界'), false);
});

test('llmAdapter: 路由可显式关闭流式请求且保持最终结果兼容', async () => {
  const ctx = baseCtx();
  const streamEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const requests: Array<Record<string, unknown>> = [];
  ctx.targetConfig = { ...ctx.targetConfig, streaming: false };
  ctx.stream = (event) => { streamEvents.push(event); };

  const got = await withFetchImplementation((async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: '非流式回答' }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(requests[0]?.['stream'], false);
  assert.equal(got.output['text'], '非流式回答');
  assert.deepEqual(streamEvents, []);
});

test('llmAdapter: 仅在提供商明确拒绝 streaming 时回退一次非流式请求', async () => {
  const ctx = baseCtx();
  const streamEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const requests: Array<Record<string, unknown>> = [];
  ctx.stream = (event) => { streamEvents.push(event); };
  ctx.audit = (event, detail) => { audits.push({ event, detail }); };
  let call = 0;

  const got = await withFetchImplementation((async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    call++;
    if (call === 1) return new Response('streaming is not supported by this model', { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '降级后回答' }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.deepEqual(requests.map((request) => request['stream']), [true, false]);
  assert.equal(got.output['text'], '降级后回答');
  assert.equal(streamEvents.some((event) => event.type === 'reset' && event.data['reason'] === 'fallback'), true);
  assert.equal(audits.some((audit) => audit.event === 'llm_stream_fallback' && audit.detail['status'] === 400), true);
});

test('llmAdapter: 普通服务端失败不得自动回退并重复请求', async () => {
  const ctx = baseCtx();
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const requests: Array<Record<string, unknown>> = [];
  ctx.stream = () => {};
  ctx.audit = (event, detail) => { audits.push({ event, detail }); };

  const got = await withFetchImplementation((async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response('upstream temporarily unavailable', { status: 503 });
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(got.ok, false);
  assert.equal(got.transient, true);
  assert.match(String(got.error), /503/);
  assert.deepEqual(requests.map((request) => request['stream']), [true]);
  assert.equal(audits.some((audit) => audit.event === 'llm_stream_fallback'), false);
});

test('llmAdapter: 流式工具参数分片可重组，工具阶段后继续输出最终文本', async () => {
  const ctx = baseCtx();
  const streamEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
  ctx.stream = (event) => { streamEvents.push(event); };
  ctx.tools = {
    llmTools: [{
      type: 'function',
      function: {
        name: 'lookup_order',
        description: '查询订单',
        parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
      },
    }],
    maxCalls: 5,
    progressive: false,
    retrievalMode: false,
    catalog: [],
    async lookup() { return []; },
    async invoke(name, args) {
      invoked.push({ name, args });
      return { ok: true, status: 200, text: '{"status":"paid"}' };
    },
  };
  let call = 0;

  const got = await withFetchImplementation((async () => {
    call++;
    if (call === 1) {
      return sseResponse([
        { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_', type: 'function', function: { name: 'lookup_', arguments: '{"id":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: '1', function: { name: 'order', arguments: '7}' } }] }, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }
    return sseResponse([
      { choices: [{ delta: { content: '订单已支付' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(call, 2);
  assert.deepEqual(invoked, [{ name: 'lookup_order', args: { id: 7 } }]);
  assert.equal(got.output['text'], '订单已支付');
  assert.equal(streamEvents.some((event) => event.type === 'phase' && event.data['name'] === 'tool'), true);
  assert.equal(streamEvents.some((event) => event.type === 'reset' && event.data['reason'] === 'tool_call'), true);
  assert.equal(streamEvents.filter((event) => event.type === 'delta').map((event) => event.data['text']).join(''), '订单已支付');
});
