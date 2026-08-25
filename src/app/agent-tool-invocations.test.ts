import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { ToolExecutionJournalEntry } from '../core/contracts/tools';
import type { AgentSession, Client, Job, Route, ToolApproval, ToolProvider } from '../core/contracts/types';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import {
  AgentToolApiError,
  invokeAgentToolFor,
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
    info: { title: 'Digital Cloud', version: '1' },
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
    audience: { enabled: true, roles: ['admin'], clients: ['digital-cloud'] },
    tools: {
      sources: [{ provider: 'digital-cloud', allow: ['*'], subject_field: 'operator_uid' }],
      max_calls: 5,
      agent_direct: { enabled: true, write_tools: ['staff_edit'] },
    },
  };
}

function auth(): AgentToolAuthContext {
  const client: Client = {
    app_id: 'digital-cloud', name: 'Digital Cloud', token: 'hidden', agent_authorize_url: 'https://biz.example.com/agent',
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
  const approvals: ToolApproval[] = [];
  const calls = new Map<string, ToolExecutionJournalEntry>();
  const key = (jobId: string, tool: string, hash: string) => `${jobId}\0${tool}\0${hash}`;
  const provider: ToolProvider = {
    name: 'digital-cloud', base_url: baseUrl, secret: 'provider-secret', enabled: true,
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
    setRoute: (value: Route) => { currentRoute = value; },
    setSpec: (value: string) => { currentSpec = value; },
    setToolRateLimited: (value: boolean) => { toolRateLimited = value; },
  };
}

test('Agent direct: 本地投影只含只读与精确写工具，写工具默认提级审批', async (t) => {
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
  assert.equal(catalog.tools.find((item) => item.name === 'staff_edit')?.approval_required, true);
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

  const pending = await invokeAgentToolFor(fx.deps, auth(), {
    invocation_id: invocationId('b'), route: 'tenant-agent', capability_revision: catalog.capability_revision,
    agent_run_id: AGENT_RUN_ID, tool: 'staff_edit', arguments: { id: 7, name: 'Ada' },
  });
  assert.equal(pending.state, 'awaiting_approval');
  assert.equal(pending.approval_id, 1);
  assert.equal(businessCalls, 1, '审批前不得外发写请求');
  assert.equal(fx.approvals.length, 1);

  fx.approvals[0]!.status = 'approved';
  // 其他工具的描述变更会改变整份 catalog revision，但 staff_edit 的执行指纹未变。
  fx.setSpec(spec().replace('查询员工', '查询门店员工'));
  const completed = await resumeAgentToolFor(fx.deps, auth(), {
    invocation_id: invocationId('b'),
  });
  assert.equal(completed.state, 'executed');
  assert.equal(businessCalls, 2);
  const again = await resumeAgentToolFor(fx.deps, auth(), {
    invocation_id: invocationId('b'),
  });
  assert.deepEqual(again, completed);
  assert.equal(businessCalls, 2, '完成后 resume 必须返回已存结果，不得重复写');
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
    sources: [{ provider: 'digital-cloud', allow: ['staff_edit'], subject_field: 'operator_uid' }],
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
