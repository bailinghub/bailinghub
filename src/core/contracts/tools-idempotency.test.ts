// 工具幂等账本单测：同 job 内"副作用工具"相同调用只真正执行一次（防 job 重试/崩溃恢复重复副作用）。
// 零依赖：stub idempotency 用内存 Map、stub audit、mock 全局 fetch 计数，不连 mysql/不发真实请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITION_SCHEMA_VERSION, type ToolDefinition } from './tool-definition';
import { buildToolRuntime, type ToolRuntimeDeps } from './tools';

function mkTool(over: Partial<ToolDefinition>): ToolDefinition {
  return {
    schemaVersion: TOOL_DEFINITION_SCHEMA_VERSION,
    name: 'create_thing', source: 'manual', method: 'POST', path: '/create', description: '建个东西', scope: 'thing.write',
    risk: 'low', confirmRequired: false, rateLimitPerMin: 0, requiresSubject: false, sensitive: false,
    readonly: false, idempotent: false, timeoutMs: 0, confirmPrompt: '',
    context: [], extensions: {},
    inputSchema: { type: 'object', properties: { x: { type: 'number' } } }, paramIn: {},
    ...over,
  };
}

function mkRuntime(tool: ToolDefinition) {
  const ledger = new Map<string, { ok: boolean; status: number; text: string }>();
  const deps: ToolRuntimeDeps = {
    provider: { name: 'p', base_url: 'http://x.invalid', secret: 's', timeout_ms: 5000, rate_limit_per_min: 0, log_payload: false } as any,
    allowedTools: [tool], maxCalls: 10, onBehalfOf: 'u1', jobId: 'job1', clientAppId: 'c', truncateBytes: 8192,
    audit: async () => { /* noop */ },
    idempotency: {
      get: async (t, h) => ledger.get(`${t}:${h}`) ?? null,
      put: async (t, h, r) => { ledger.set(`${t}:${h}`, r); },
    },
  };
  return buildToolRuntime(deps);
}

function mkRuntimeWithApprovals(tool: ToolDefinition) {
  let created = 0;
  let notified = 0;
  const createdSnaps: any[] = [];
  const notifiedSnaps: any[] = [];
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const deps: ToolRuntimeDeps = {
    provider: { name: 'p', base_url: 'http://x.invalid', secret: 's', timeout_ms: 5000, rate_limit_per_min: 0, log_payload: false } as any,
    allowedTools: [tool], maxCalls: 10, onBehalfOf: 'tenant_1:user_9', jobId: 'job1', clientAppId: 'c', truncateBytes: 8192,
    audit: async (event, detail) => { audits.push({ event, detail }); },
    approvals: {
      consumeApproved: async () => null,
      findPending: async () => null,
      findApprovedAnyArgs: async () => null,
      create: async (snap) => { createdSnaps.push(snap); return ++created; },
      notify: async (_id, snap) => { notifiedSnaps.push(snap); notified++; },
    },
  };
  return { runtime: buildToolRuntime(deps), count: () => ({ created, notified, createdSnaps, notifiedSnaps, audits }) };
}

async function withFetchCounter(fn: (count: () => number) => Promise<void>): Promise<void> {
  let n = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { n++; return { status: 200, text: async () => '{"ok":true}' } as unknown as Response; }) as typeof fetch;
  try { await fn(() => n); } finally { globalThis.fetch = orig; }
}

test('副作用工具：同 job 同参数第二次调用被去重，只真正执行一次', async () => {
  const rt = mkRuntime(mkTool({}));
  await withFetchCounter(async (count) => {
    const r1 = await rt.invoke('create_thing', { x: 1 });
    assert.equal(r1.ok, true);
    assert.equal(count(), 1, '第一次应真正发出');
    const r2 = await rt.invoke('create_thing', { x: 1 });
    assert.equal(r2.ok, true, '第二次返回上次缓存结果');
    assert.equal(count(), 1, '相同调用不应再次发出（防重复副作用）');
    await rt.invoke('create_thing', { x: 2 });
    assert.equal(count(), 2, '参数不同是另一次调用，应真正发出');
  });
});

test('副作用工具：幂等哈希与实际 JSON 外发参数使用同一规范化语义', async () => {
  const rt = mkRuntime(mkTool({}));
  await withFetchCounter(async (count) => {
    await rt.invoke('create_thing', { optional: undefined });
    await rt.invoke('create_thing', {});
    assert.equal(count(), 1, 'undefined 在 JSON 对象中会省略，不能被视为另一项副作用调用');
  });
});

test('只读/声明幂等工具：不进账本，每次都真正执行（不去重）', async () => {
  const rt = mkRuntime(mkTool({ name: 'list_things', method: 'GET', readonly: true, idempotent: true }));
  await withFetchCounter(async (count) => {
    await rt.invoke('list_things', { x: 1 });
    await rt.invoke('list_things', { x: 1 });
    assert.equal(count(), 2, '只读工具重复调用应每次都执行，不缓存（拿最新数据）');
  });
});

test('工具调用：path/header/query/body 参数按 ToolDefinition.paramIn 组装', async () => {
  const rt = mkRuntime(mkTool({
    name: 'update_staff',
    path: '/stores/{store_id}/staff/{staff_id}',
    paramIn: { store_id: 'path', staff_id: 'path', tenant: 'header', dry_run: 'query', name: 'body' },
    inputSchema: { type: 'object', properties: {} },
    readonly: true,
    idempotent: true,
  }));
  const orig = globalThis.fetch;
  let seenUrl = '';
  let seenHeaders: unknown;
  let seenBody: unknown;
  globalThis.fetch = (async (url, init) => {
    seenUrl = String(url);
    seenHeaders = init?.headers;
    seenBody = init?.body;
    return { status: 200, text: async () => '{"ok":true}' } as unknown as Response;
  }) as typeof fetch;
  try {
    await rt.invoke('update_staff', { store_id: 's 1', staff_id: 'u/2', tenant: 't1', dry_run: true, name: 'Alice' });
  } finally {
    globalThis.fetch = orig;
  }
  assert.match(seenUrl, /\/stores\/s%201\/staff\/u%2F2\?dry_run=true$/);
  assert.equal((seenHeaders as Record<string, string>)['tenant'], 't1');
  assert.equal(String(seenBody), JSON.stringify({ name: 'Alice' }));
});

test('参数级确认：未命中 ACC approval.when 正常执行，命中后进入审批且不外发', async () => {
  const { runtime, count } = mkRuntimeWithApprovals(mkTool({
    name: 'refund_create',
    description: '创建退款',
    scope: 'refund.write',
    confirmWhen: [{ param: 'amount', op: '>', value: 1000, label: '退款金额超过 1000' }],
    confirmPrompt: 'AI 申请退款 {amount} 元',
    inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
  }));

  await withFetchCounter(async (fetchCount) => {
    const small = await runtime.invoke('refund_create', { amount: 99 });
    assert.equal(small.ok, true);
    assert.equal(fetchCount(), 1, '小额未命中条件，应真正发出');

    const large = await runtime.invoke('refund_create', { amount: 1200 });
    assert.equal(large.ok, false);
    assert.match(large.text, /审批单/);
    assert.equal(fetchCount(), 1, '大额命中条件，应先审批、不外发');

    const malformed = await runtime.invoke('refund_create', { amount: '1200' as unknown as number });
    assert.equal(malformed.ok, false);
    assert.match(malformed.text, /参数类型/);
    assert.equal(fetchCount(), 1, '条件参数类型不符时必须拒绝，不能静默绕过审批');
  });

  const got = count();
  assert.equal(got.created, 1);
  assert.equal(got.notified, 1);
  assert.equal(got.createdSnaps[0].policy, 'confirm_when');
  assert.equal(got.createdSnaps[0].reason, '退款金额超过 1000');
  assert.equal(got.createdSnaps[0].summary, 'AI 申请退款 1200 元');
  assert.equal(got.notifiedSnaps[0].policy, 'confirm_when');
  const pending = got.audits.find((a) => a.event === 'tool_approval_pending');
  assert.deepEqual(pending?.detail['confirm_when'], {
    param: 'amount',
    op: '>',
    value: 1000,
    actual: 1200,
    reason: '退款金额超过 1000',
  });
});

test('参数级确认：布尔值不与同名字符串混同', async () => {
  const { runtime, count } = mkRuntimeWithApprovals(mkTool({
    name: 'feature_switch',
    confirmWhen: [{ param: 'enabled', op: '==', value: true, label: '启用功能需确认' }],
    inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } } },
  }));

  await withFetchCounter(async (fetchCount) => {
    const result = await runtime.invoke('feature_switch', { enabled: 'true' as unknown as boolean });
    assert.equal(result.ok, false);
    assert.match(result.text, /参数类型/);
    assert.equal(fetchCount(), 0, '类型不符时不能外发');
  });

  assert.equal(count().created, 0, '类型不符不是审批意图，必须由调用方按 schema 修正');
});

test('参数级确认：绕过编译器的无类型条件也必须在运行时拦截', async () => {
  const runtime = mkRuntime(mkTool({
    name: 'untyped_condition',
    confirmWhen: [{ param: 'submitted', op: 'exists' }],
    inputSchema: { type: 'object', properties: { submitted: {} } },
  }));

  await withFetchCounter(async (fetchCount) => {
    const result = await runtime.invoke('untyped_condition', { submitted: true });
    assert.equal(result.ok, false);
    assert.match(result.text, /审批条件参数类型/);
    assert.equal(fetchCount(), 0, '无类型审批条件不能绕过出站闸门');
  });
});
