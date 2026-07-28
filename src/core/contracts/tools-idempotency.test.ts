// 工具幂等账本单测：同 job 内"副作用工具"相同调用只真正执行一次（防 job 重试/崩溃恢复重复副作用）。
// 零依赖：stub idempotency 用内存 Map、stub audit、mock 全局 fetch 计数，不连 mysql/不发真实请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITION_SCHEMA_VERSION, type ToolDefinition } from './tool-definition';
import { argsHash, buildToolRuntime, toolCallIdempotencyKey, type ToolExecutionJournalEntry, type ToolRuntimeDeps } from './tools';

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

function mkRuntime(
  tool: ToolDefinition,
  audit: ToolRuntimeDeps['audit'] = async () => { /* noop */ },
  ledger = new Map<string, ToolExecutionJournalEntry>(),
) {
  const deps: ToolRuntimeDeps = {
    provider: { name: 'p', base_url: 'http://x.invalid', secret: 's', timeout_ms: 5000, rate_limit_per_min: 0, log_payload: false } as any,
    allowedTools: [tool], maxCalls: 10, onBehalfOf: 'u1', jobId: 'job1', clientAppId: 'c', truncateBytes: 8192,
    audit,
    idempotency: {
      get: async (t, h) => ledger.get(`${t}:${h}`) ?? null,
      reserve: async (t, _scope, h, idempotencyKey) => {
        const key = `${t}:${h}`;
        const prior = ledger.get(key);
        if (prior) return { inserted: false, entry: prior };
        const entry: ToolExecutionJournalEntry = { state: 'dispatching', ok: false, status: 0, text: '', idempotencyKey };
        ledger.set(key, entry);
        return { inserted: true, entry };
      },
      recordResponse: async (t, h, r) => {
        const key = `${t}:${h}`;
        const prior = ledger.get(key);
        assert.equal(prior?.state, 'dispatching');
        ledger.set(key, { ...prior!, ...r, state: 'response_recorded' });
      },
      complete: async (t, h) => {
        const key = `${t}:${h}`;
        const prior = ledger.get(key);
        assert.equal(prior?.state, 'response_recorded');
        ledger.set(key, { ...prior!, state: 'completed' });
      },
      markUncertain: async (t, h, error) => {
        const key = `${t}:${h}`;
        const prior = ledger.get(key)!;
        ledger.set(key, { ...prior, state: 'uncertain', error });
      },
      markEvidenceDegraded: async (t, h, error) => {
        const key = `${t}:${h}`;
        const prior = ledger.get(key)!;
        ledger.set(key, { ...prior, state: 'evidence_degraded', error });
      },
    },
  };
  return buildToolRuntime(deps);
}

function mkRuntimeWithApprovals(tool: ToolDefinition) {
  let created = 0;
  let notified = 0;
  const ledger = new Map<string, ToolExecutionJournalEntry>();
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
    idempotency: {
      get: async (t, h) => ledger.get(`${t}:${h}`) ?? null,
      reserve: async (t, _scope, h, idempotencyKey) => {
        const key = `${t}:${h}`;
        const prior = ledger.get(key);
        if (prior) return { inserted: false, entry: prior };
        const entry: ToolExecutionJournalEntry = { state: 'dispatching', ok: false, status: 0, text: '', idempotencyKey };
        ledger.set(key, entry);
        return { inserted: true, entry };
      },
      recordResponse: async (t, h, r) => {
        const key = `${t}:${h}`;
        ledger.set(key, { ...ledger.get(key)!, ...r, state: 'response_recorded' });
      },
      complete: async (t, h) => {
        const key = `${t}:${h}`;
        ledger.set(key, { ...ledger.get(key)!, state: 'completed' });
      },
      markUncertain: async (t, h, error) => {
        const key = `${t}:${h}`;
        ledger.set(key, { ...ledger.get(key)!, state: 'uncertain', error });
      },
      markEvidenceDegraded: async (t, h, error) => {
        const key = `${t}:${h}`;
        ledger.set(key, { ...ledger.get(key)!, state: 'evidence_degraded', error });
      },
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

test('副作用工具：缺少持久化执行日志时 fail-closed，请求不得外发', async () => {
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const runtime = buildToolRuntime({
    provider: { name: 'p', base_url: 'http://x.invalid', secret: 's', timeout_ms: 5000, rate_limit_per_min: 0, log_payload: false } as any,
    allowedTools: [mkTool({})],
    maxCalls: 10,
    onBehalfOf: 'u1',
    jobId: 'job1',
    clientAppId: 'c',
    truncateBytes: 8192,
    audit: async (event, detail) => { audits.push({ event, detail }); },
  });

  await withFetchCounter(async (count) => {
    const result = await runtime.invoke('create_thing', { x: 1 });
    assert.equal(result.ok, false);
    assert.match(result.text, /持久化执行日志/);
    assert.equal(count(), 0);
  });
  assert.equal(audits.at(-1)?.event, 'tool_blocked');
});

test('副作用工具：执行日志查询不可用时先于审批 fail-closed，不消费批准也不外发', async () => {
  let approvalConsumes = 0;
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const runtime = buildToolRuntime({
    provider: { name: 'p', base_url: 'http://x.invalid', secret: 's', timeout_ms: 5000, rate_limit_per_min: 0, log_payload: false } as any,
    allowedTools: [mkTool({ name: 'refund_create', risk: 'high', confirmRequired: true })],
    maxCalls: 10,
    onBehalfOf: 'u1',
    jobId: 'job1',
    clientAppId: 'c',
    truncateBytes: 8192,
    audit: async (event, detail) => { audits.push({ event, detail }); },
    approvals: {
      consumeApproved: async () => { approvalConsumes++; return 42; },
      findPending: async () => null,
      findApprovedAnyArgs: async () => null,
      create: async () => 1,
      notify: async () => undefined,
    },
    idempotency: {
      get: async () => { throw new Error('journal unavailable'); },
      reserve: async () => { throw new Error('reserve must not run'); },
      recordResponse: async () => { throw new Error('recordResponse must not run'); },
      complete: async () => { throw new Error('complete must not run'); },
      markUncertain: async () => undefined,
      markEvidenceDegraded: async () => undefined,
    },
  });

  await withFetchCounter(async (count) => {
    const result = await runtime.invoke('refund_create', { x: 1 });
    assert.equal(result.ok, false);
    assert.match(result.text, /执行日志当前不可用/);
    assert.match(result.text, /未消费审批/);
    assert.equal(approvalConsumes, 0, '账本状态未知时不得提前消费批准');
    assert.equal(count(), 0, '账本状态未知时不得外发业务请求');
  });
  assert.equal(audits.at(-1)?.event, 'tool_blocked');
  assert.equal(audits.at(-1)?.detail['reason'], '执行日志查询不可用，请求未发出');
});

test('副作用工具：下游超时后冻结执行，恢复或重跑不得再次发出', async () => {
  const ledger = new Map<string, ToolExecutionJournalEntry>();
  const rt = mkRuntime(mkTool({}), undefined, ledger);
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new TypeError('connection reset after request');
  }) as typeof fetch;
  try {
    const first = await rt.invoke('create_thing', { x: 7 });
    assert.equal(first.ok, false);
    assert.match(first.text, /人工对账/);
    assert.equal(rt.executionUncertainty()?.state, 'uncertain');

    const recoveredRuntime = mkRuntime(mkTool({}), undefined, ledger);
    const second = await recoveredRuntime.invoke('create_thing', { x: 7 });
    assert.equal(second.ok, false);
    assert.match(second.text, /人工对账/);
    assert.equal(recoveredRuntime.executionUncertainty()?.state, 'uncertain');
    assert.equal(calls, 1, '进程恢复后也不得自动重放结果不确定的业务请求');
  } finally {
    globalThis.fetch = orig;
  }
});

test('副作用工具：崩溃遗留 dispatching 占位时，新运行时 fail-closed 且不外发', async () => {
  const callArgs = { x: 10 };
  const hash = argsHash(callArgs);
  const idempotencyKey = toolCallIdempotencyKey('job1', 'create_thing', hash, 'u1');
  const ledger = new Map<string, ToolExecutionJournalEntry>([
    [`create_thing:${hash}`, {
      state: 'dispatching',
      ok: false,
      status: 0,
      text: '',
      idempotencyKey,
    }],
  ]);
  const recoveredRuntime = mkRuntime(mkTool({}), undefined, ledger);

  await withFetchCounter(async (count) => {
    const result = await recoveredRuntime.invoke('create_thing', callArgs);
    assert.equal(result.ok, false);
    assert.match(result.text, /人工对账/);
    assert.equal(recoveredRuntime.executionUncertainty()?.state, 'dispatching');
    assert.equal(count(), 0, '已有 dispatching 日志意味着发送结果未知，恢复后不得猜测并重发');
  });
});

test('副作用工具：业务响应后审计失败进入 evidence_degraded，不把失败伪装成可重试', async () => {
  const rt = mkRuntime(mkTool({}), async (event) => {
    if (event === 'tool_result') throw new Error('audit sink unavailable');
  });
  await withFetchCounter(async (count) => {
    const result = await rt.invoke('create_thing', { x: 8 });
    assert.equal(result.ok, false);
    assert.match(result.text, /审计证据不完整/);
    assert.equal(rt.executionUncertainty()?.state, 'evidence_degraded');
    assert.equal(count(), 1);

    await rt.invoke('create_thing', { x: 8 });
    assert.equal(count(), 1, '业务响应后的审计故障不能触发第二次业务调用');
  });
});

test('副作用工具：发送稳定的下游幂等键，且该键与任务、主体、工具和规范化参数绑定', async () => {
  const rt = mkRuntime(mkTool({}));
  const orig = globalThis.fetch;
  let seen = '';
  globalThis.fetch = (async (_url, init) => {
    seen = String((init?.headers as Record<string, string>)['x-bailing-idempotency-key'] ?? '');
    return { status: 200, text: async () => '{"ok":true}' } as unknown as Response;
  }) as typeof fetch;
  try {
    await rt.invoke('create_thing', { x: 9 });
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(seen, toolCallIdempotencyKey('job1', 'create_thing', argsHash({ x: 9 }), 'u1'));
  assert.match(seen, /^[0-9a-f]{64}$/);
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
