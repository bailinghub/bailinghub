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
