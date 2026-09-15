import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { LocalSlidingWindowRateLimiter } from '../core/contracts/tools';
import type { AppConfig } from '../core/config/config';
import type { ToolExecutionJournalEntry } from '../core/contracts/tools';
import type { AgentSession, Client, Job, Route, ToolApproval, ToolProvider } from '../core/contracts/types';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { AgentClientRunRecord } from '../infrastructure/config/config-agent-client-runtime-repository';
import {
  AgentToolApiError,
  invokeAgentToolFor,
  inspectAgentToolInvocationFor,
  listAgentToolsFor,
  resumeAgentToolFor,
  type AgentToolAuthContext,
} from './agent-tool-invocations';
import type { ToolProxyDeps } from './tool-proxy';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_RUN_ID = '22222222-2222-4222-8222-222222222222';

function invocationId(char: string): string { return char.repeat(64); }

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing address'));
      else resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function acc(scope: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { 'x-agent-capability': { version: 1, enabled: true, scope, subject: { required: true }, ...extra } };
}

function spec(): string {
  return JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Example Business', version: '1' },
    paths: {
      '/staff/list': {
        get: {
          operationId: 'staff_list', summary: '查询员工', ...acc('tenant.staff.read'),
          parameters: [{ name: 'keyword', in: 'query', description: '关键字', schema: { type: 'string', maxLength: 64 } }],
        },
      },
      '/staff/edit': {
        post: {
          operationId: 'staff_edit', summary: '修改员工', ...acc('tenant.staff.write', { risk: { level: 'medium' } }),
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['id', 'name'], additionalProperties: false,
            properties: { id: { type: 'integer' }, name: { type: 'string', minLength: 1, maxLength: 64 } },
          } } } },
        },
      },
      '/recharge/refund': {
        post: {
          operationId: 'recharge_refund', summary: '资金退款，不可撤销', ...acc('tenant.recharge.write', { risk: { level: 'medium' } }),
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['id'], properties: { id: { type: 'integer' } },
          } } } },
        },
      },
    },
  });
}

class MemoryState {
  jobs = new Map<string, Job>();
  byRequest = new Map<string, string>();
  locks = new Map<string, string>();
  audits: Array<Record<string, unknown>> = [];

  async findByRequestId(requestId: string) { const id = this.byRequest.get(requestId); return id ? this.jobs.get(id) ?? null : null; }
  async createJob(job: Job) { if (this.byRequest.has(job.request_id)) throw new Error('duplicate'); this.jobs.set(job.job_id, job); this.byRequest.set(job.request_id, job.job_id); }
  async updateJob(jobId: string, patch: Partial<Job>) { const job = this.jobs.get(jobId); if (!job) return null; const next = { ...job, ...patch, updated_at: new Date().toISOString() }; this.jobs.set(jobId, next); return next; }
  async getJob(jobId: string) { return this.jobs.get(jobId) ?? null; }
  async appendAudit(entry: Record<string, unknown>) { this.audits.push(entry); }
  async acquireRuntimeLock(key: string, owner: string) { if (this.locks.has(key)) return false; this.locks.set(key, owner); return true; }
  async releaseRuntimeLock(key: string, owner: string) { if (this.locks.get(key) === owner) this.locks.delete(key); }
}

function route(): Route {
  return {
    route_key: 'tenant-agent', name: '门店助手', enabled: true, target: 'llm', target_config: {},
    profile: 'general', permission: 'full', session_policy: 'new',
    audience: { enabled: true, roles: ['admin'], clients: ['example-business'] },
    tools: {
      sources: [{ provider: 'example-business', allow: ['*'], subject_field: 'operator_uid' }],
      max_calls: 5,
      agent_direct: { enabled: true, write_tools: ['staff_edit'] },
    },
  };
}

function routeWithForcedApproval(tool = 'staff_edit'): Route {
  const value = route();
  value.tools = {
    ...value.tools,
    agent_direct: { enabled: true, write_tools: ['staff_edit'], force_approval_tools: [tool] },
  };
  return value;
}

function auth(): AgentToolAuthContext {
  const client: Client = {
    app_id: 'example-business', name: 'Example Business', token: 'hidden', agent_authorize_url: 'https://biz.example.com/agent',
    allowed_routes: ['tenant-agent'], allowed_channels: [], rate_limit_per_min: 0, enabled: true,
  };
  const session: AgentSession = {
    session_id: SESSION_ID, client_app_id: client.app_id, device_label: 'test',
    principal: { id: 'u7', tenant: 't1', roles: ['admin'] }, on_behalf_of: 't1:u7',
    allowed_routes: ['tenant-agent'], created_at: '2026-01-01T00:00:00.000Z',
    access_expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-02-01T00:00:00.000Z',
  };
  return { client, session };
}

function fixture(baseUrl: string) {
  const state = new MemoryState();
  let currentRoute = route();
  let currentSpec = spec();
  let toolRateLimited = false;
  let runtimeRun: AgentClientRunRecord | null = null;
  const approvals: ToolApproval[] = [];
  const calls = new Map<string, ToolExecutionJournalEntry>();
  const key = (jobId: string, tool: string, hash: string) => `${jobId}\0${tool}\0${hash}`;
  const provider: ToolProvider = {
    name: 'example-business', base_url: baseUrl, secret: 'provider-secret', enabled: true,
    spec_source: 'inline', get spec_json() { return currentSpec; },
    log_payload: false, timeout_ms: 10_000, rate_limit_per_min: 0,
  } as ToolProvider;
  const config = {
    routes: { get: async () => currentRoute },
    toolProviders: { get: async () => provider },
    rateLimits: { consume: async () => toolRateLimited },
    approvals: {
      forJob: async (jobId: string) => approvals.filter((item) => item.job_id === jobId),
      approvedUnusedForJob: async (jobId: string) => approvals.filter((item) => item.job_id === jobId && item.status === 'approved' && !item.used_at),
      find: async (jobId: string, tool: string, hash: string, status: string, unused = false) => approvals.find((item) => item.job_id === jobId && item.tool === tool && item.args_hash === hash && item.status === status && (!unused || !item.used_at)) ?? null,
      use: async (id: number) => { const item = approvals.find((row) => row.id === id); if (!item || item.status !== 'approved' || item.used_at) return false; item.used_at = new Date().toISOString(); return true; },
      create: async (value: Omit<ToolApproval, 'id' | 'status' | 'created_at'>) => {
        const id = approvals.length + 1;
        approvals.push({ ...value, id, status: 'pending', created_at: new Date().toISOString() });
        return id;
      },
    },
    toolCalls: {
      get: async (jobId: string, tool: string, hash: string) => calls.get(key(jobId, tool, hash)) ?? null,
      reserve: async (jobId: string, tool: string, _scope: string, hash: string, idempotencyKey: string) => {
        const k = key(jobId, tool, hash); const existing = calls.get(k);
        if (existing) return { inserted: false, entry: existing };
        const entry: ToolExecutionJournalEntry = { state: 'dispatching', ok: false, status: 0, text: '', idempotencyKey };
        calls.set(k, entry); return { inserted: true, entry };
      },
      recordResponse: async (jobId: string, tool: string, hash: string, response: { ok: boolean; status: number; text: string }) => {
        const k = key(jobId, tool, hash); const old = calls.get(k); if (!old) throw new Error('missing');
        calls.set(k, { ...old, ...response, state: 'response_recorded' });
      },
      complete: async (jobId: string, tool: string, hash: string) => { const k = key(jobId, tool, hash); const old = calls.get(k); if (!old) throw new Error('missing'); calls.set(k, { ...old, state: 'completed' }); },
      markUncertain: async (jobId: string, tool: string, hash: string, error: string) => { const k = key(jobId, tool, hash); const old = calls.get(k); if (old) calls.set(k, { ...old, state: 'uncertain', error }); },
      markEvidenceDegraded: async (jobId: string, tool: string, hash: string, error: string) => { const k = key(jobId, tool, hash); const old = calls.get(k); if (old) calls.set(k, { ...old, state: 'evidence_degraded', error }); },
    },
    agentClientRuntime: { findRunForInvocation: async () => runtimeRun },
  } as unknown as ConfigStoreContract;
  const deps: ToolProxyDeps = {
    cfg: { brand: { name: 'BailingHub' }, server: { token: 'server-token' } } as AppConfig,
    configStore: config, stateStore: state as unknown as RuntimeStateStore, toolIndex: null,
    now: () => new Date().toISOString(), sleep: async () => undefined,
  };
  return {
    deps,
    state,
    approvals,
    calls,
    setRoute: (value: Route) => { currentRoute = value; },
    setSpec: (value: string) => { currentSpec = value; },
    setToolRateLimited: (value: boolean) => { toolRateLimited = value; provider.tool_rate_limits = { default: { mode: 'custom', count: 120, window: '1h' }, overrides: {} }; },
    setRuntimeRun: (value: AgentClientRunRecord | null) => { runtimeRun = value; },
  };
}

function runtimeRun(overrides: Partial<AgentClientRunRecord> = {}): AgentClientRunRecord {
  return {
    run_id: AGENT_RUN_ID, session_id: SESSION_ID, client_app_id: 'example-business', route_key: 'tenant-agent', thread_id: 42,
    client_conversation_id: 'c1', client_turn_id: 't1', user_message_id: 'm1', request_hash: 'a'.repeat(64), user_input: 'query',
    context: { schema_version: 'bailing.agent-turn-context.v1' }, status: 'context_ready', completion_hash: null,
    assistant_message_id: null, final_content: null, model: null, runtime: null, usage: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', completed_at: null,
    ...overrides,
  };
}

async function pendingReceiptFixture() {
  const fx = fixture('https://business.invalid');
  fx.setRoute(routeWithForcedApproval());
  fx.setRuntimeRun(runtimeRun());
  const catalog = await listAgentToolsFor(fx.deps, auth(), 'tenant-agent');
  const input = {
    invocation_id: invocationId('a'), route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_edit', arguments: { id: 1, name: 'Synthetic' },
  };
  const result = await invokeAgentToolFor(fx.deps, auth(), input);
  assert.equal(result.state, 'awaiting_approval');
  const job = [...fx.state.jobs.values()][0]!;
  return { ...fx, input, result, job };
}

function forbidReceiptMutations(fx: Awaited<ReturnType<typeof pendingReceiptFixture>>) {
  const snapshot = () => JSON.stringify({ jobs: [...fx.state.jobs], approvals: fx.approvals, calls: [...fx.calls], audits: fx.state.audits });
  const before = snapshot();
  const forbidden = async () => { throw new Error('inspection_attempted_mutation'); };
  fx.state.createJob = forbidden;
  fx.state.updateJob = forbidden;
  fx.state.appendAudit = forbidden;
  fx.state.acquireRuntimeLock = forbidden;
  fx.state.releaseRuntimeLock = forbidden;
  fx.deps.configStore!.approvals.use = forbidden;
  fx.deps.configStore!.approvals.create = forbidden;
  fx.deps.configStore!.rateLimits.consume = forbidden;
  fx.deps.configStore!.toolCalls.reserve = forbidden;
  fx.deps.configStore!.toolCalls.complete = forbidden;
  fx.deps.configStore!.toolCalls.recordResponse = forbidden;
  // Inspection needs no original encrypted arguments or server decryption secret.
  fx.deps.cfg.server.token = 'synthetic-rotated-key';
  return () => assert.equal(snapshot(), before, 'inspection must not alter original execution evidence');
}

test('Agent receipt: approved original remains undispatched across repeated read-only inspections', async () => {
  const fx = await pendingReceiptFixture();
  fx.approvals[0]!.status = 'approved';
  const unchanged = forbidReceiptMutations(fx);
  for (let attempt = 0; attempt < 2; attempt++) {
    const receipt = await inspectAgentToolInvocationFor(fx.deps, auth(), fx.input);
    assert.equal(receipt.schema_version, 'bailing.agent-invocation-receipt.v1');
    assert.equal(receipt.read_only, true);
    assert.equal(receipt.business_operation_performed, false);
    assert.equal(receipt.agent_run_id, AGENT_RUN_ID);
    assert.equal(receipt.invocation_id, fx.input.invocation_id);
    assert.equal(receipt.dispatch_state, 'not_dispatched');
    assert.equal(receipt.journal_state, 'absent');
    assert.deepEqual(receipt.result, fx.result);
    assert.deepEqual(receipt.approval, { status: 'approved', approval_id: 1 });
    assert.equal(fx.approvals[0]!.used_at, undefined);
  }
  unchanged();
});

test('Agent receipt: completed journal supersedes a stale job without persisting or dispatching', async () => {
  const fx = await pendingReceiptFixture();
  fx.calls.set(`${fx.job.job_id}\0staff_edit\0${fx.job.metadata.agent_args_hash}`, {
    state: 'completed', ok: true, status: 200, text: 'Synthetic completion', idempotencyKey: 'synthetic-original-key',
  });
  const unchanged = forbidReceiptMutations(fx);
  const receipt = await inspectAgentToolInvocationFor(fx.deps, auth(), fx.input);
  assert.equal(receipt.result_source, 'journal');
  assert.equal(receipt.journal_state, 'completed');
  assert.equal(receipt.result?.state, 'executed');
  assert.equal(receipt.result?.auto_retry_allowed, false);
  assert.equal(receipt.dispatch_state, 'attempted');
  assert.equal(receipt.result?.text, 'Synthetic completion');
  assert.equal(JSON.stringify(receipt).includes('synthetic-original-key'), false);
  unchanged();
});

test('Agent receipt: unresolved or malformed journal never grants a repeat operation', async (t) => {
  for (const state of ['dispatching', 'response_recorded', 'uncertain', 'evidence_degraded', 'unexpected'] as const) {
    await t.test(state, async () => {
      const fx = await pendingReceiptFixture();
      fx.calls.set(`${fx.job.job_id}\0staff_edit\0${fx.job.metadata.agent_args_hash}`, {
        state, ok: true, status: 200, text: 'Unconfirmed synthetic content', idempotencyKey: 'synthetic-original-key',
      } as ToolExecutionJournalEntry);
      const unchanged = forbidReceiptMutations(fx);
      const receipt = await inspectAgentToolInvocationFor(fx.deps, auth(), fx.input);
      assert.equal(receipt.journal_state, state === 'unexpected' ? 'unknown' : state);
      assert.equal(receipt.result_source, 'journal');
      assert.equal(receipt.result?.state, 'reconciliation_required');
      assert.equal(receipt.result?.auto_retry_allowed, false);
      assert.equal(receipt.business_operation_performed, false);
      assert.equal(JSON.stringify(receipt).includes('Unconfirmed synthetic content'), false);
      unchanged();
    });
  }
});

test('Agent receipt: result JSON is allowlisted and invalid schema stays unknown', async () => {
  const fx = await pendingReceiptFixture();
  fx.job.result = { ...fx.result, private_data: 'synthetic-hidden', rate_limit: {
    level: 'tool', count: 120, window_sec: 3600, scope: 'tool_provider_shared', source: 'override', token: 'synthetic-secret',
  } };
  const receipt = await inspectAgentToolInvocationFor(fx.deps, auth(), fx.input);
  assert.equal(JSON.stringify(receipt).includes('synthetic-hidden'), false);
  assert.equal(JSON.stringify(receipt).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(receipt).includes('agent_frozen_arguments'), false);
  fx.job.result = { ...fx.result, schema_version: 'unknown-schema' };
  delete fx.job.metadata.agent_dispatch_attempted;
  const unchanged = forbidReceiptMutations(fx);
  const unknown = await inspectAgentToolInvocationFor(fx.deps, auth(), fx.input);
  assert.equal(unknown.result, null);
  assert.equal(unknown.result_source, 'none');
  assert.equal(unknown.dispatch_state, 'unknown');
  unchanged();
});

test('Agent receipt: capability declaration changes do not require historical execution fingerprints', async () => {
  const fx = await pendingReceiptFixture();
  const changed = JSON.parse(spec());
  changed.paths['/staff/edit'].post.summary = 'Updated synthetic description';
  changed.paths['/staff/edit'].post.requestBody.content['application/json'].schema.properties.note = { type: 'string' };
  fx.setSpec(JSON.stringify(changed));
  const unchanged = forbidReceiptMutations(fx);
  assert.equal((await inspectAgentToolInvocationFor(fx.deps, auth(), fx.input)).result?.state, 'awaiting_approval');
  unchanged();
});

test('Agent receipt: current tool revocation still forbids access to original result content', async () => {
  const fx = await pendingReceiptFixture();
  const changed = routeWithForcedApproval();
  changed.tools = { ...changed.tools, agent_direct: { enabled: true, write_tools: [] } };
  fx.setRoute(changed);
  const unchanged = forbidReceiptMutations(fx);
  await assert.rejects(inspectAgentToolInvocationFor(fx.deps, auth(), fx.input),
    (error) => error instanceof AgentToolApiError && error.code === 'capability_changed');
  unchanged();
});

test('Agent receipt: original session, client, principal, route and run bindings cannot be changed', async (t) => {
  for (const drift of ['session', 'client', 'principal', 'tenant', 'on_behalf_of', 'run', 'route', 'thread'] as const) {
    await t.test(drift, async () => {
      const fx = await pendingReceiptFixture();
      const caller = auth();
      if (drift === 'session') caller.session.session_id = '33333333-3333-4333-8333-333333333333';
      if (drift === 'client') caller.client.app_id = 'another-client';
      if (drift === 'principal') caller.session.principal.id = 'another-user';
      if (drift === 'tenant') caller.session.principal.tenant = 'another-tenant';
      if (drift === 'on_behalf_of') caller.session.on_behalf_of = 'another-subject';
      if (drift === 'run') fx.setRuntimeRun(runtimeRun({ session_id: '33333333-3333-4333-8333-333333333333' }));
      if (drift === 'route') fx.setRuntimeRun(runtimeRun({ route_key: 'another-route' }));
      if (drift === 'thread') fx.setRuntimeRun(runtimeRun({ thread_id: 99 }));
      const unchanged = forbidReceiptMutations(fx);
      await assert.rejects(inspectAgentToolInvocationFor(fx.deps, caller, fx.input),
        (error) => error instanceof AgentToolApiError && ['invocation_not_found', 'invocation_conflict', 'agent_run_conflict'].includes(error.code));
      unchanged();
    });
  }
});

test('Agent receipt: absent original or malformed identifier never creates substitute evidence', async () => {
  const fx = await pendingReceiptFixture();
  const unchanged = forbidReceiptMutations(fx);
  await assert.rejects(inspectAgentToolInvocationFor(fx.deps, auth(), { invocation_id: invocationId('b') }),
    (error) => error instanceof AgentToolApiError && error.statusCode === 404 && error.code === 'invocation_not_found');
  await assert.rejects(inspectAgentToolInvocationFor(fx.deps, auth(), { invocation_id: 'bad-id' }),
    (error) => error instanceof AgentToolApiError && error.statusCode === 400);
  unchanged();
});

test('Agent direct: 本地投影只含只读与精确写工具，写工具默认继承 ACC 审批声明', async (t) => {
  let businessCalls = 0;
  const business = createServer(async (req, res) => {
    businessCalls++;
    assert.equal(req.headers['x-bailing-on-behalf-of'], 't1:u7');
    assert.match(String(req.headers['x-bailing-signature']), /^sha256=[a-f0-9]{64}$/);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url, body: Buffer.concat(chunks).toString('utf8') }));
  });
  const port = await listen(business);
  t.after(() => close(business));
  const fx = fixture(`http://127.0.0.1:${port}`);

  const catalog = await listAgentToolsFor(fx.deps, auth(), 'tenant-agent');
  assert.deepEqual(catalog.tools.map((item) => item.name), ['staff_edit', 'staff_list']);
  assert.equal(catalog.tools.find((item) => item.name === 'staff_edit')?.approval_required, false);
  assert.equal(catalog.tools.some((item) => item.name === 'recharge_refund'), false);
  assert.equal(JSON.stringify(catalog).includes('provider-secret'), false);
  assert.equal(JSON.stringify(catalog).includes('127.0.0.1'), false);

  const read = await invokeAgentToolFor(fx.deps, auth(), {
    invocation_id: invocationId('a'), route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_list', arguments: { keyword: 'Ada' },
  });
  assert.equal(read.state, 'executed');
  assert.equal(read.ok, true);
  assert.equal(businessCalls, 1);
  assert.ok([...fx.state.jobs.values()].every((job) => job.target === 'agent-tool-v1' && job.status === 'done'));

  const write = await invokeAgentToolFor(fx.deps, auth(), {
    invocation_id: invocationId('b'), route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_edit', arguments: { id: 7, name: 'Ada' },
  });
  assert.equal(write.state, 'executed');
  assert.equal(write.ok, true);
  assert.equal(businessCalls, 2);
  assert.equal(fx.approvals.length, 0);
});

test('Agent direct: 路由精确列出的写工具额外强制审批并可续执行', async (t) => {
  let businessCalls = 0;
  const business = createServer((_req, res) => {
    businessCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const port = await listen(business);
  t.after(() => close(business));
  const fx = fixture(`http://127.0.0.1:${port}`);
  fx.setRoute(routeWithForcedApproval());

  const catalog = await listAgentToolsFor(fx.deps, auth(), 'tenant-agent');
  assert.equal(catalog.tools.find((item) => item.name === 'staff_edit')?.approval_required, true);
  const pending = await invokeAgentToolFor(fx.deps, auth(), {
    invocation_id: invocationId('8'), route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_edit', arguments: { id: 7, name: 'Ada' },
  });
  assert.equal(pending.state, 'awaiting_approval');
  assert.equal(pending.approval_id, 1);
  assert.equal(businessCalls, 0, '审批前不得外发写请求');
  assert.equal(fx.approvals.length, 1);

  fx.approvals[0]!.status = 'approved';
  // 其他工具的描述变更会改变整份 catalog revision，但 staff_edit 的执行指纹未变。
  fx.setSpec(spec().replace('查询员工', '查询门店员工'));
  const completed = await resumeAgentToolFor(fx.deps, auth(), {
    invocation_id: invocationId('8'),
  });
  assert.equal(completed.state, 'executed');
  assert.equal(businessCalls, 1);
  const again = await resumeAgentToolFor(fx.deps, auth(), {
    invocation_id: invocationId('8'),
  });
  assert.deepEqual(again, completed);
  assert.equal(businessCalls, 1, '完成后 resume 必须返回已存结果，不得重复写');
});

test('Agent direct: ACC 高风险写工具在默认继承模式下仍需要审批', async () => {
  const fx = fixture('https://business.invalid');
  fx.setSpec(spec().replace('"risk":{"level":"medium"}', '"risk":{"level":"high"}'));
  const catalog = await listAgentToolsFor(fx.deps, auth(), 'tenant-agent');
  assert.equal(catalog.tools.find((item) => item.name === 'staff_edit')?.approval_required, true);
  const pending = await invokeAgentToolFor(fx.deps, auth(), {
    invocation_id: invocationId('6'), route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_edit', arguments: { id: 7, name: 'Ada' },
  });
  assert.equal(pending.state, 'awaiting_approval');
  assert.equal(fx.approvals.length, 1);
});

test('Agent direct: invocation 与 agent_run_id/参数不可变绑定', async (t) => {
  let businessCalls = 0;
  const business = createServer((_req, res) => {
    businessCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const port = await listen(business);
  t.after(() => close(business));
  const fx = fixture(`http://127.0.0.1:${port}`);
  const authorized = auth();
  const catalog = await listAgentToolsFor(fx.deps, authorized, 'tenant-agent');
  const original = {
    invocation_id: invocationId('d'), route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_list', arguments: { keyword: 'Ada' },
  };
  assert.equal((await invokeAgentToolFor(fx.deps, authorized, original)).state, 'executed');
  await assert.rejects(
    invokeAgentToolFor(fx.deps, authorized, { ...original, agent_run_id: '33333333-3333-4333-8333-333333333333' }),
    (error) => error instanceof AgentToolApiError && error.code === 'invocation_conflict',
  );
  await assert.rejects(
    invokeAgentToolFor(fx.deps, authorized, { ...original, arguments: { keyword: 'Grace' } }),
    (error) => error instanceof AgentToolApiError && error.code === 'invocation_conflict',
  );
  authorized.session.allowed_routes = [];
  await assert.rejects(
    invokeAgentToolFor(fx.deps, authorized, original),
    (error) => error instanceof AgentToolApiError && error.code === 'route_not_allowed',
  );
  assert.equal(businessCalls, 1);
});

test('Agent direct: Runtime run 重验 session/route，合法 run 把 thread 关联到 job 与审计', async (t) => {
  const business = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const port = await listen(business);
  t.after(() => close(business));
  const fx = fixture(`http://127.0.0.1:${port}`);
  const authorized = auth();
  const catalog = await listAgentToolsFor(fx.deps, authorized, 'tenant-agent');
  const input = {
    invocation_id: invocationId('7'), route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_list', arguments: {},
  };
  fx.setRuntimeRun(runtimeRun({ session_id: '99999999-9999-4999-8999-999999999999' }));
  await assert.rejects(
    invokeAgentToolFor(fx.deps, authorized, input),
    (error) => error instanceof AgentToolApiError && error.code === 'agent_run_conflict',
  );

  fx.setRuntimeRun(runtimeRun());
  assert.equal((await invokeAgentToolFor(fx.deps, authorized, input)).state, 'executed');
  const job = [...fx.state.jobs.values()].find((candidate) => candidate.metadata?.['agent_invocation_id'] === input.invocation_id);
  assert.equal(job?.thread_id, 42);
  const created = fx.state.audits.find((entry) => entry['event'] === 'agent_tool_invocation_created') as any;
  assert.equal(created?.detail?.agent_thread_id, 42);
});

test('Agent direct: 终态回放仍重验当前具体工具授权', async (t) => {
  let businessCalls = 0;
  const business = createServer((_req, res) => {
    businessCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const port = await listen(business);
  t.after(() => close(business));
  const fx = fixture(`http://127.0.0.1:${port}`);
  const authorized = auth();
  const catalog = await listAgentToolsFor(fx.deps, authorized, 'tenant-agent');
  const original = {
    invocation_id: invocationId('9'), route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_list', arguments: { keyword: 'Ada' },
  };
  assert.equal((await invokeAgentToolFor(fx.deps, authorized, original)).state, 'executed');

  const narrowed = route();
  narrowed.tools = {
    ...narrowed.tools,
    sources: [{ provider: 'example-business', allow: ['staff_edit'], subject_field: 'operator_uid' }],
  };
  fx.setRoute(narrowed);
  await assert.rejects(
    invokeAgentToolFor(fx.deps, authorized, original),
    (error) => error instanceof AgentToolApiError && error.code === 'capability_changed',
  );
  await assert.rejects(
    resumeAgentToolFor(fx.deps, authorized, { invocation_id: original.invocation_id }),
    (error) => error instanceof AgentToolApiError && error.code === 'capability_changed',
  );
  assert.equal(businessCalls, 1, '授权撤销后不得因终态回放再次访问业务侧');
});

test('Agent direct: 当前工具执行契约变更时审批快照不执行', async () => {
  const fx = fixture('https://business.invalid');
  fx.setRoute(routeWithForcedApproval());
  const catalog = await listAgentToolsFor(fx.deps, auth(), 'tenant-agent');
  const pending = await invokeAgentToolFor(fx.deps, auth(), {
    invocation_id: invocationId('e'), route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_edit', arguments: { id: 7, name: 'Ada' },
  });
  assert.equal(pending.state, 'awaiting_approval');
  fx.approvals[0]!.status = 'approved';
  fx.setSpec(spec().replace('/staff/edit', '/staff/edit-v2'));
  await assert.rejects(
    resumeAgentToolFor(fx.deps, auth(), {
      invocation_id: invocationId('e'),
    }),
    (error) => error instanceof AgentToolApiError && error.code === 'capability_changed',
  );
  assert.equal(fx.approvals[0]!.used_at, undefined);
});

test('Agent direct: 工具限流不消费批准，同 invocation 可安全重试', async (t) => {
  let businessCalls = 0;
  const business = createServer((_req, res) => {
    businessCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const port = await listen(business);
  t.after(() => close(business));
  const fx = fixture(`http://127.0.0.1:${port}`);
  fx.setRoute(routeWithForcedApproval());
  const catalog = await listAgentToolsFor(fx.deps, auth(), 'tenant-agent');
  const invocation_id = invocationId('f');
  const pending = await invokeAgentToolFor(fx.deps, auth(), {
    invocation_id, route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_edit', arguments: { id: 7, name: 'Ada' },
  });
  assert.equal(pending.state, 'awaiting_approval');
  fx.approvals[0]!.status = 'approved';
  fx.setToolRateLimited(true);
  const limited = await resumeAgentToolFor(fx.deps, auth(), {
    invocation_id,
  });
  assert.equal(limited.state, 'rejected_before_dispatch');
  assert.equal(limited.auto_retry_allowed, true);
  assert.equal(limited.business_status, undefined);
  assert.equal(fx.approvals[0]!.used_at, undefined);
  assert.equal(businessCalls, 0);

  fx.setToolRateLimited(false);
  const completed = await resumeAgentToolFor(fx.deps, auth(), {
    invocation_id,
  });
  assert.equal(completed.state, 'executed');
  assert.ok(fx.approvals[0]!.used_at);
  assert.equal(businessCalls, 1);
});

test('Agent direct: transport uncertainty and lost client receipts resume the original result without redispatch', async (t) => {
  for (const kind of ['readonly', 'idempotent_write', 'non_idempotent_write'] as const) {
    for (const failure of ['fetch_rejected', 'response_body_lost', 'client_receipt_lost'] as const) {
      await t.test(`${kind}: ${failure}`, async (t) => {
        let attempts = 0;
        t.mock.method(globalThis, 'fetch', async () => {
          attempts++;
          if (failure === 'fetch_rejected') throw new TypeError('synthetic transport failure');
          if (failure === 'client_receipt_lost') return new Response('{"ok":true}', { status: 200 });
          return { status: 200, text: async () => { throw new TypeError('synthetic response body loss'); } } as unknown as Response;
        });
        const fx = fixture('https://business.invalid');
        if (kind === 'idempotent_write') {
          const declaration = JSON.parse(spec());
          declaration.paths['/staff/edit'].post['x-agent-capability'].execution = { readonly: false, idempotent: true };
          fx.setSpec(JSON.stringify(declaration));
        }
        const caller = auth();
        const catalog = await listAgentToolsFor(fx.deps, caller, 'tenant-agent');
        const tool = kind === 'readonly' ? 'staff_list' : 'staff_edit';
        const definition = catalog.tools.find((item) => item.name === tool)!;
        assert.equal(definition.readonly, kind === 'readonly');
        assert.equal(definition.idempotent, kind !== 'non_idempotent_write');
        const input = {
          invocation_id: invocationId('a'), route: 'tenant-agent', capability_revision: catalog.capability_revision,
          agent_run_id: AGENT_RUN_ID, tool,
          arguments: kind === 'readonly' ? { keyword: 'Synthetic' } : { id: 1, name: 'Synthetic' },
        };
        // For a lost client receipt the business result is already persisted; the client only
        // retains its invocation ID and must recover it instead of submitting another operation.
        const first = await invokeAgentToolFor(fx.deps, caller, input);
        const confirmed = failure === 'client_receipt_lost';
        assert.equal(first.state, confirmed ? 'executed' : 'reconciliation_required');
        assert.equal(first.auto_retry_allowed, false);
        assert.equal(first.ok, confirmed);
        assert.equal(first.business_status, confirmed ? 200 : undefined, 'only a trusted business response confirms business status');
        assert.equal(attempts, 1);

        assert.deepEqual(await resumeAgentToolFor(fx.deps, caller, { invocation_id: input.invocation_id }), first);
        assert.deepEqual(await invokeAgentToolFor(fx.deps, caller, input), first);
        assert.equal(attempts, 1, 'resume and same-invocation replay must never dispatch a replacement request');
        assert.equal(fx.state.jobs.size, 1);

        caller.session.allowed_routes = [];
        await assert.rejects(
          resumeAgentToolFor(fx.deps, caller, { invocation_id: input.invocation_id }),
          (error) => error instanceof AgentToolApiError && error.code === 'route_not_allowed',
        );
        assert.equal(attempts, 1, 'uncertainty never bypasses the current authorization boundary');
      });
    }
  }
});

test('Agent direct: an unapproved rate-limited write resumes its sealed original arguments after restart and lost ACK', async (t) => {
  const received: unknown[] = [];
  const business = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += String(chunk);
    received.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  const port = await listen(business); t.after(() => close(business));
  const fx = fixture(`http://127.0.0.1:${port}`);
  fx.setToolRateLimited(true);
  const catalog = await listAgentToolsFor(fx.deps, auth(), 'tenant-agent');
  const invocation_id = invocationId('9');
  const limited = await invokeAgentToolFor(fx.deps, auth(), {
    invocation_id, route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_edit', arguments: { id: 7, name: 'Synthetic name' },
  });
  assert.equal(limited.state, 'rejected_before_dispatch');
  assert.equal(limited.retry_after_ms, 3_600_000);
  assert.equal(limited.rate_limit?.scope, 'tool_provider_shared');
  assert.equal(received.length, 0);
  assert.equal(fx.approvals.length, 0);
  assert.doesNotMatch(JSON.stringify([...fx.state.jobs.values()]), /Synthetic name/);
  assert.equal((await resumeAgentToolFor(fx.deps, auth(), { invocation_id })).auto_retry_allowed, true);
  // New coordinator, JSON round trip of the persisted jobs, original Session/run/invocation.
  const restarted = fixture(`http://127.0.0.1:${port}`);
  for (const job of fx.state.jobs.values()) await restarted.state.createJob(JSON.parse(JSON.stringify(job)));
  const result = await resumeAgentToolFor(restarted.deps, auth(), { invocation_id });
  assert.equal(result.state, 'executed');
  assert.deepEqual(received, [{ id: 7, name: 'Synthetic name' }]);
  assert.deepEqual(await resumeAgentToolFor(restarted.deps, auth(), { invocation_id }), result);
  assert.equal(received.length, 1);
  assert.ok([...restarted.state.jobs.values()].every((job) => !job.metadata.agent_frozen_arguments));
});

test('Agent direct: the third burst write under 120/hour reaches business; closing Hub tool limits keeps the provider gate', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{"ok":true}'); });
  const fx = fixture('https://business.invalid');
  const definition = JSON.parse(spec());
  definition.paths['/staff/edit'].post['x-agent-capability'].execution = { rate_limit: { count: 120, window: '1h' } };
  fx.setSpec(JSON.stringify(definition));
  const limiter = new LocalSlidingWindowRateLimiter(() => 0);
  fx.deps.configStore!.rateLimits.consumeAll = async (gates) => limiter.consumeAll(gates);
  const catalog = await listAgentToolsFor(fx.deps, auth(), 'tenant-agent');
  const invoke = (id: string) => invokeAgentToolFor(fx.deps, auth(), { invocation_id: invocationId(id), route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_edit', arguments: { id: 7, name: id } });
  for (const id of ['1', '2', '3']) assert.equal((await invoke(id)).state, 'executed');
  assert.equal(calls, 3);
  const provider = (await fx.deps.configStore!.toolProviders.get('example-business'))!;
  provider.tool_rate_limits = { default: { mode: 'disabled' }, overrides: {} };
  provider.rate_limit_per_min = 1;
  assert.equal((await invoke('4')).state, 'executed');
  const blocked = await invoke('5');
  assert.equal(blocked.rate_limit?.level, 'provider');
  assert.equal(calls, 4);
  provider.rate_limit_per_min = 0;
  assert.equal((await resumeAgentToolFor(fx.deps, auth(), { invocation_id: invocationId('5') })).state, 'executed');
  assert.equal(calls, 5);
});

test('Agent direct: corrupt snapshot and uncertain dispatch fence never replay a write', async (t) => {
  for (const failure of ['corrupt_snapshot', 'rotated_key', 'dispatch_in_progress', 'journal_unavailable'] as const) {
    await t.test(failure, async (t) => {
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{"ok":true}'); });
      const fx = fixture('https://business.invalid'); fx.setToolRateLimited(true);
      const catalog = await listAgentToolsFor(fx.deps, auth(), 'tenant-agent');
      const invocation_id = invocationId('8');
      await invokeAgentToolFor(fx.deps, auth(), { invocation_id, route: 'tenant-agent', capability_revision: catalog.capability_revision,
        agent_run_id: AGENT_RUN_ID, tool: 'staff_edit', arguments: { id: 7, name: 'Synthetic name' } });
      fx.setToolRateLimited(false);
      const job = [...fx.state.jobs.values()][0]!;
      if (failure === 'corrupt_snapshot') job.metadata.agent_frozen_arguments = 'v1.invalid.snapshot';
      if (failure === 'rotated_key') fx.deps.cfg.server.token = 'rotated-synthetic-key';
      if (failure === 'dispatch_in_progress') {
        job.metadata.agent_dispatch_attempted = true;
        job.result = { ...job.result, state: 'in_progress', auto_retry_allowed: false };
      }
      if (failure === 'journal_unavailable') {
        fx.deps.configStore!.toolCalls.get = async () => { throw new Error('synthetic_storage_unavailable'); };
        await assert.rejects(resumeAgentToolFor(fx.deps, auth(), { invocation_id }), /synthetic_storage_unavailable/);
      } else {
        const result = await resumeAgentToolFor(fx.deps, auth(), { invocation_id });
        assert.equal(result.auto_retry_allowed, false);
        assert.equal(result.state, failure === 'dispatch_in_progress' ? 'reconciliation_required' : 'rejected_before_dispatch');
      }
      assert.equal(calls, 0);
    });
  }
});

test('Agent direct: failure to persist the dispatch fence makes zero business requests and remains recoverable', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{"ok":true}'); });
  const fx = fixture('https://business.invalid');
  const catalog = await listAgentToolsFor(fx.deps, auth(), 'tenant-agent');
  const update = t.mock.method(fx.state, 'updateJob', async () => null);
  const invocation_id = invocationId('7');
  await assert.rejects(invokeAgentToolFor(fx.deps, auth(), { invocation_id, route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_edit', arguments: { id: 7, name: 'Synthetic' } }),
    (error) => error instanceof AgentToolApiError && error.code === 'invocation_storage_unavailable');
  assert.equal(calls, 0);
  update.mock.restore();
  assert.equal((await resumeAgentToolFor(fx.deps, auth(), { invocation_id })).state, 'executed');
  assert.equal(calls, 1);
});

test('Agent direct: capability revision 变更、参数漂移和未开启路由均失败关闭', async () => {
  const fx = fixture('https://business.invalid');
  const catalog = await listAgentToolsFor(fx.deps, auth(), 'tenant-agent');
  fx.setSpec(spec().replace('查询员工', '查询门店员工'));
  await assert.rejects(
    invokeAgentToolFor(fx.deps, auth(), {
      invocation_id: invocationId('c'), route: 'tenant-agent', capability_revision: catalog.capability_revision,
      agent_run_id: AGENT_RUN_ID, tool: 'staff_list', arguments: {},
    }),
    (error) => error instanceof AgentToolApiError && error.code === 'capability_changed',
  );

  const disabled = route();
  disabled.tools = { ...disabled.tools, agent_direct: { enabled: false } };
  fx.setRoute(disabled);
  await assert.rejects(
    listAgentToolsFor(fx.deps, auth(), 'tenant-agent'),
    (error) => error instanceof AgentToolApiError && error.code === 'agent_direct_disabled',
  );
});
