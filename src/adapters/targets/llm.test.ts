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

function toolDef(name: string, description = name): NonNullable<AdapterContext['tools']>['llmTools'][number] {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties: {} },
    },
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
    executionUncertainty() { return null; },
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
  assert.equal(completed?.detail['reasoning_chars'], 0);
  assert.equal(typeof completed?.detail['duration_ms'], 'number');
  assert.equal(completed?.detail['message_count'], 2);
  assert.equal(completed?.detail['tools_count'], 0);
  assert.equal(typeof completed?.detail['request_chars'], 'number');
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
    executionUncertainty() { return null; },
  };
  let call = 0;
  const requests: Array<Record<string, unknown>> = [];

  const got = await withFetchImplementation((async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    call++;
    if (call === 1) {
      return sseResponse([
        { choices: [{ delta: { role: 'assistant', reasoning_content: '需要查询订单。', tool_calls: [{ index: 0, id: 'call_', type: 'function', function: { name: 'lookup_', arguments: '{"id":' } }] } }] },
        { choices: [{ delta: { reasoning_content: '查询后回答。', tool_calls: [{ index: 0, id: '1', function: { name: 'order', arguments: '7}' } }] }, finish_reason: 'tool_calls' }] },
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
  const secondMessages = requests[1]?.['messages'] as Array<Record<string, unknown>>;
  const assistantToolMessage = secondMessages.find((message) => message['role'] === 'assistant' && Array.isArray(message['tool_calls']));
  assert.equal(assistantToolMessage?.['reasoning_content'], '需要查询订单。查询后回答。');
  assert.equal(got.output['text'], '订单已支付');
  assert.equal(streamEvents.some((event) => event.type === 'phase' && event.data['name'] === 'tool'), true);
  assert.equal(streamEvents.some((event) => event.type === 'reset' && event.data['reason'] === 'tool_call'), true);
  assert.equal(streamEvents.filter((event) => event.type === 'delta').map((event) => event.data['text']).join(''), '订单已支付');
});

test('llmAdapter: 每轮告知路由级工具余额，接近和达到上限后强制收尾', async () => {
  const ctx = baseCtx();
  const requests: Array<Record<string, unknown>> = [];
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const invoked: string[] = [];
  ctx.targetConfig = { ...ctx.targetConfig, streaming: false };
  ctx.audit = (event, detail) => { audits.push({ event, detail }); };
  ctx.tools = {
    llmTools: [toolDef('lookup_order', '查询订单')],
    maxCalls: 2,
    progressive: false,
    retrievalMode: false,
    catalog: [],
    async lookup() { return []; },
    async invoke(name) { invoked.push(name); return { ok: true, status: 200, text: '{"status":"paid"}' }; },
    executionUncertainty() { return null; },
  };

  const got = await withFetchImplementation((async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push(body);
    if (requests.length <= 2) {
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: `call-${requests.length}`, type: 'function', function: { name: 'lookup_order', arguments: '{}' } }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '根据已经查到的结果，订单已支付。' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(got.ok, true);
  assert.deepEqual(invoked, ['lookup_order', 'lookup_order']);
  assert.equal(requests.length, 3);
  assert.equal(Array.isArray(requests[0]?.['tools']), true);
  assert.equal(Array.isArray(requests[1]?.['tools']), true);
  assert.equal('tools' in (requests[2] ?? {}), false);
  assert.match(JSON.stringify(requests[1]?.['messages']), /已使用 1\/2，\u53ea剩 1 次/);
  assert.match(JSON.stringify(requests[2]?.['messages']), /已使用 2\/2，剩余 0 次/);
  assert.deepEqual(got.output['tool_budget'], { used: 2, limit: 2, remaining: 0, exhausted: true });
  assert.equal(audits.some((audit) => audit.event === 'tool_budget_near_limit'), true);
  assert.equal(audits.some((audit) => audit.event === 'tool_budget_exhausted'), true);
});

test('llmAdapter: 路由配置超过旧 12 轮时仍以自身 maxCalls 为准', async () => {
  const ctx = baseCtx();
  let requestCount = 0;
  let invokeCount = 0;
  ctx.targetConfig = { ...ctx.targetConfig, streaming: false };
  ctx.tools = {
    llmTools: [toolDef('lookup_order', '查询订单')],
    maxCalls: 13,
    progressive: false,
    retrievalMode: false,
    catalog: [],
    async lookup() { return []; },
    async invoke() { invokeCount++; return { ok: true, status: 200, text: '{"status":"paid"}' }; },
    executionUncertainty() { return null; },
  };

  const got = await withFetchImplementation((async () => {
    requestCount++;
    if (requestCount <= 13) {
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: `call-${requestCount}`, type: 'function', function: { name: 'lookup_order', arguments: '{}' } }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '13 次查询完成，现已汇总结果。' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(got.ok, true);
  assert.equal(requestCount, 14);
  assert.equal(invokeCount, 13);
  assert.deepEqual(got.output['tool_budget'], { used: 13, limit: 13, remaining: 0, exhausted: true });
});

test('llmAdapter: 工具额度耗尽后的 DSML 流式协议被清除并只允许一次安全重写', async () => {
  const ctx = baseCtx();
  const requests: Array<Record<string, unknown>> = [];
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const streamEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  ctx.audit = (event, detail) => { audits.push({ event, detail }); };
  ctx.stream = (event) => { streamEvents.push(event); };
  ctx.tools = {
    llmTools: [toolDef('report_business', '查询营业数据')],
    maxCalls: 1,
    progressive: false,
    retrievalMode: false,
    catalog: [],
    async lookup() { return []; },
    async invoke() { return { ok: true, status: 200, text: '{"amount":100}' }; },
    executionUncertainty() { return null; },
  };

  const got = await withFetchImplementation((async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push(body);
    if (requests.length === 1) {
      return sseResponse([
        { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'report_business', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }
    if (requests.length === 2) {
      return sseResponse([
        { choices: [{ delta: { content: '我再查一下。' } }] },
        { choices: [{ delta: { content: '<｜｜DS' } }] },
        { choices: [{ delta: { content: 'ML｜｜function_calls><｜｜DSML｜｜invoke name="report_business">' }, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }
    return sseResponse([
      { choices: [{ delta: { content: '根据已经查到的数据，本次金额为 100 元。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(got.ok, true);
  assert.equal(got.output['text'], '根据已经查到的数据，本次金额为 100 元。');
  assert.equal(got.output['output_protocol_repaired'], true);
  assert.deepEqual(got.output['tool_budget'], { used: 1, limit: 1, remaining: 0, exhausted: true });
  assert.equal(requests.length, 3);
  assert.equal('tools' in (requests[1] ?? {}), false);
  assert.equal('tools' in (requests[2] ?? {}), false);
  assert.equal(streamEvents.some((event) => event.type === 'reset' && event.data['reason'] === 'protocol_violation'), true);
  assert.equal(streamEvents.filter((event) => event.type === 'delta').some((event) => String(event.data['text']).includes('DSML')), false);
  assert.equal(audits.some((audit) => audit.event === 'llm_output_protocol_violation' && audit.detail['marker'] === 'dsml_tool_markup'), true);
  assert.equal(audits.some((audit) => audit.event === 'llm_output_protocol_repaired'), true);
  const thirdMessages = requests[2]?.['messages'] as Array<Record<string, unknown>>;
  assert.equal(thirdMessages.some((message) => message['role'] === 'assistant' && String(message['content'] ?? '').includes('DSML')), false);
});

test('llmAdapter: 非流式终稿中的内部协议被拦截并安全重写', async () => {
  const ctx = baseCtx();
  const requests: Array<Record<string, unknown>> = [];
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  ctx.targetConfig = { ...ctx.targetConfig, streaming: false };
  ctx.audit = (event, detail) => { audits.push({ event, detail }); };

  const got = await withFetchImplementation((async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const content = requests.length === 1
      ? '<｜｜DSML｜｜>'
      : '现有信息不足，暂时无法继续查询。';
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(got.ok, true);
  assert.equal(got.output['text'], '现有信息不足，暂时无法继续查询。');
  assert.equal(got.output['output_protocol_repaired'], true);
  assert.equal(requests.length, 2);
  assert.equal('tools' in (requests[1] ?? {}), false);
  assert.equal(audits.some((audit) => audit.event === 'llm_output_protocol_violation'), true);
  assert.equal(audits.some((audit) => audit.event === 'llm_output_protocol_repaired'), true);
});

test('llmAdapter: 安全重写再次输出内部协议时失败关闭', async () => {
  const ctx = baseCtx();
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  ctx.targetConfig = { ...ctx.targetConfig, streaming: false };
  ctx.audit = (event, detail) => { audits.push({ event, detail }); };

  const got = await withMockFetch([
    { choices: [{ message: { content: '<｜｜DSML｜｜tool_calls>' }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: '<|tool_call|>' }, finish_reason: 'stop' }] },
  ], () => llmAdapter.run(ctx));

  assert.equal(got.ok, false);
  assert.equal(got.transient, false);
  assert.match(String(got.error), /连续输出内部工具协议/);
  assert.equal(audits.filter((audit) => audit.event === 'llm_output_protocol_violation').length, 2);
});

test('llmAdapter: 预算耗尽后模型仍返回结构化工具调用时不执行并改写终稿', async () => {
  const ctx = baseCtx();
  const requests: Array<Record<string, unknown>> = [];
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  let invokeCount = 0;
  ctx.targetConfig = { ...ctx.targetConfig, streaming: false };
  ctx.audit = (event, detail) => { audits.push({ event, detail }); };
  ctx.tools = {
    llmTools: [toolDef('report_business', '查询营业数据')],
    maxCalls: 1,
    progressive: false,
    retrievalMode: false,
    catalog: [],
    async lookup() { return []; },
    async invoke() {
      invokeCount++;
      return { ok: true, status: 200, text: '{"amount":100}' };
    },
    executionUncertainty() { return null; },
  };

  const got = await withFetchImplementation((async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    if (requests.length < 3) {
      return new Response(JSON.stringify({ choices: [{ message: {
        content: null,
        tool_calls: [{ id: `call-${requests.length}`, type: 'function', function: { name: 'report_business', arguments: '{}' } }],
      }, finish_reason: 'tool_calls' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '根据已取得的数据，本次金额为 100 元。' }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(got.ok, true);
  assert.equal(got.output['text'], '根据已取得的数据，本次金额为 100 元。');
  assert.equal(invokeCount, 1);
  assert.equal(requests.length, 3);
  assert.equal('tools' in (requests[1] ?? {}), false);
  assert.equal('tools' in (requests[2] ?? {}), false);
  assert.equal(audits.some((audit) => audit.event === 'llm_output_protocol_violation' && audit.detail['marker'] === 'structured_tool_call_after_finalize'), true);
});

test('llmAdapter: 未配置语音策略时关闭式提示，绝不把音频盲送给主模型', async () => {
  const ctx = baseCtx();
  const requests: Array<Record<string, unknown>> = [];
  ctx.userAudio = ['https://media.example.com/message.mp3'];
  ctx.targetConfig = { ...ctx.targetConfig, streaming: false };

  const got = await withFetchImplementation((async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '语音暂时无法解析，请改用文字。' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(got.ok, true);
  assert.equal(JSON.stringify(requests).includes('input_audio'), false);
  assert.match(JSON.stringify(requests[0]?.['messages']), /请其改用文字/);
});

test('llmAdapter: 只有显式 inline 才把音频作为 input_audio 交给主模型', async () => {
  const ctx = baseCtx();
  const requests: Array<Record<string, unknown>> = [];
  ctx.userAudio = ['https://media.example.com/message.mp3'];
  ctx.targetConfig = {
    ...ctx.targetConfig,
    streaming: false,
    input: { audio: { mode: 'inline' } },
  };

  await withFetchImplementation((async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '收到语音' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(JSON.stringify(requests).includes('input_audio'), true);
});

test('llmAdapter: 显式转写但 ASR 不可解析时关闭式降级，不回退为 inline', async () => {
  const ctx = baseCtx();
  const requests: Array<Record<string, unknown>> = [];
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  ctx.userAudio = ['https://media.example.com/message.mp3'];
  ctx.audit = (event, detail) => { audits.push({ event, detail }); };
  ctx.targetConfig = {
    ...ctx.targetConfig,
    streaming: false,
    input: {
      audio: {
        mode: 'transcribe',
        credential: 'missing-asr',
        model: 'qwen3-asr-flash',
        protocol: 'chat_input_audio',
      },
    },
  };

  await withFetchImplementation((async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '请改用文字。' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(JSON.stringify(requests).includes('input_audio'), false);
  assert.match(JSON.stringify(requests[0]?.['messages']), /未配置可用的语音识别/);
  assert.equal(
    audits.some((audit) => audit.event === 'speech_degraded' && audit.detail['reason'] === 'audio_model_unresolved'),
    true,
  );
});

test('llmAdapter: 语义工具追加检索最多两次且只向模型报告真正新增的工具', async () => {
  const ctx = baseCtx();
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const requests: Array<Record<string, unknown>> = [];
  const retrievalQueries: string[] = [];
  ctx.targetConfig = { ...ctx.targetConfig, streaming: false };
  ctx.audit = (event, detail) => { audits.push({ event, detail }); };
  ctx.tools = {
    llmTools: [toolDef('seed_tool'), toolDef('tool_a'), toolDef('tool_b')],
    maxCalls: 5,
    progressive: false,
    retrievalMode: true,
    catalog: [],
    async lookup() { return []; },
    async retrieve(query) {
      retrievalQueries.push(query);
      if (query === ctx.userQuery) return [toolDef('seed_tool')];
      if (query === '第一次追加') return [toolDef('seed_tool'), toolDef('tool_a')];
      return [toolDef('tool_a'), toolDef('tool_b')];
    },
    async invoke() { return { ok: true, status: 200, text: '{}' }; },
    executionUncertainty() { return null; },
  };

  const got = await withFetchImplementation((async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push(body);
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: 'search-1', type: 'function', function: { name: 'search_tools', arguments: '{"query":"第一次追加"}' } }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (requests.length === 2) {
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: 'search-2', type: 'function', function: { name: 'search_tools', arguments: '{"query":"第二次追加"}' } }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '检索完成' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(got.ok, true);
  assert.deepEqual(retrievalQueries, [ctx.userQuery, '第一次追加', '第二次追加']);
  assert.equal(requests.length, 3);
  const firstTools = requests[0]?.['tools'] as Array<{ function?: { name?: string } }>;
  const secondTools = requests[1]?.['tools'] as Array<{ function?: { name?: string } }>;
  const thirdTools = requests[2]?.['tools'] as Array<{ function?: { name?: string } }>;
  assert.equal(firstTools.some((tool) => tool.function?.name === 'search_tools'), true);
  assert.equal(secondTools.some((tool) => tool.function?.name === 'search_tools'), true);
  assert.equal(thirdTools.some((tool) => tool.function?.name === 'search_tools'), false);
  assert.deepEqual(
    thirdTools.map((tool) => tool.function?.name),
    ['seed_tool', 'tool_a', 'tool_b'],
  );

  const thirdMessages = requests[2]?.['messages'] as Array<Record<string, unknown>>;
  const searchResults = thirdMessages
    .filter((message) => message['role'] === 'tool')
    .map((message) => String(message['content']));
  assert.match(searchResults[0] ?? '', /新增 1 个可用工具：tool_a/);
  assert.doesNotMatch(searchResults[0] ?? '', /seed_tool/);
  assert.match(searchResults[1] ?? '', /新增 1 个可用工具：tool_b/);
  assert.match(searchResults[1] ?? '', /追加检索已经结束/);

  const completed = audits.filter((audit) => audit.event === 'tools_search_completed');
  assert.equal(completed.length, 2);
  assert.equal(completed[1]?.detail['reason'], 'budget_exhausted');
  assert.equal(completed[1]?.detail['exhausted'], true);
});

test('llmAdapter: 语义工具检索没有新增项时立即收口并停止暴露 search_tools', async () => {
  const ctx = baseCtx();
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const requests: Array<Record<string, unknown>> = [];
  let retrievalCalls = 0;
  ctx.targetConfig = { ...ctx.targetConfig, streaming: false };
  ctx.audit = (event, detail) => { audits.push({ event, detail }); };
  ctx.tools = {
    llmTools: [toolDef('seed_tool')],
    maxCalls: 5,
    progressive: false,
    retrievalMode: true,
    catalog: [],
    async lookup() { return []; },
    async retrieve() {
      retrievalCalls++;
      return [toolDef('seed_tool')];
    },
    async invoke() { return { ok: true, status: 200, text: '{}' }; },
    executionUncertainty() { return null; },
  };

  const got = await withFetchImplementation((async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push(body);
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: 'search-1', type: 'function', function: { name: 'search_tools', arguments: '{"query":"同义查询"}' } }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '没有新增能力' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(got.ok, true);
  assert.equal(retrievalCalls, 2);
  assert.equal(requests.length, 2);
  const secondTools = requests[1]?.['tools'] as Array<{ function?: { name?: string } }>;
  assert.equal(secondTools.some((tool) => tool.function?.name === 'search_tools'), false);
  const secondMessages = requests[1]?.['messages'] as Array<Record<string, unknown>>;
  assert.match(
    String(secondMessages.find((message) => message['role'] === 'tool')?.['content']),
    /本次检索没有新增工具/,
  );
  assert.equal(
    audits.some((audit) => audit.event === 'tools_search_completed' && audit.detail['reason'] === 'no_new_tools'),
    true,
  );
});

test('llmAdapter: 初始语义检索不可用时首轮立即退回目录与 find_tools', async () => {
  const ctx = baseCtx();
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const requests: Array<Record<string, unknown>> = [];
  const definitions = Array.from({ length: 13 }, (_value, index) => toolDef(`tool_${index + 1}`));
  ctx.targetConfig = { ...ctx.targetConfig, streaming: false };
  ctx.audit = (event, detail) => { audits.push({ event, detail }); };
  ctx.tools = {
    llmTools: definitions,
    maxCalls: 5,
    progressive: true,
    retrievalMode: true,
    catalog: definitions.map((definition) => ({
      name: definition.function.name,
      summary: definition.function.description,
      scope: 'read',
      risk: 'low',
      confirm_required: false,
    })),
    async lookup() { return []; },
    async retrieve() { return null; },
    async invoke() { return { ok: true, status: 200, text: '{}' }; },
    executionUncertainty() { return null; },
  };

  const got = await withFetchImplementation((async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: '已降级但仍可回答' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => llmAdapter.run(ctx));

  assert.equal(got.ok, true);
  assert.equal(requests.length, 1);
  const tools = requests[0]?.['tools'] as Array<{ function?: { name?: string } }>;
  assert.deepEqual(tools.map((tool) => tool.function?.name), ['find_tools']);
  assert.equal(tools.some((tool) => tool.function?.name === 'search_tools'), false);
  assert.match(JSON.stringify(requests[0]?.['messages']), /业务工具目录/);
  assert.equal(
    audits.some((audit) => audit.event === 'tools_retrieval_degraded' && audit.detail['reason'] === 'retrieve_unavailable'),
    true,
  );
});
