import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { AgentSession, Client, Job, Route, ToolProvider } from '../core/contracts/types';
import type { AppConfig } from '../core/config/config';
import type { AgentClientRunRecord } from '../infrastructure/config/config-agent-client-runtime-repository';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import { tokenHash } from './agent-auth';
import { handleAgentApiHttpFor } from './agent-api';
import type { ToolProxyDeps } from '../app/tool-proxy';

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string | number | string[]> = {};
  body = Buffer.alloc(0);
  setHeader(name: string, value: string | number | string[]): void { this.headers[name.toLowerCase()] = value; }
  writeHead(code: number, headers?: Record<string, string | number | string[]>): void {
    this.statusCode = code;
    for (const [name, value] of Object.entries(headers ?? {})) this.headers[name.toLowerCase()] = value;
  }
  end(value?: string | Buffer): void { this.body = value ? Buffer.from(value) : Buffer.alloc(0); }
  json(): Record<string, unknown> { return JSON.parse(this.body.toString('utf8')) as Record<string, unknown>; }
}

function request(method: string, headers: Record<string, string> = {}, body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = method;
  req.headers = headers;
  return req;
}

test('Agent API job reads are isolated to the originating Agent Session', async () => {
  const token = `bha_${'a'.repeat(43)}`;
  const client: Client = {
    app_id: 'example-business', name: 'Example Business', token: 'client-token',
    agent_authorize_url: 'https://tenant.example.com/agent-authorize',
    allowed_routes: ['orders'], allowed_channels: [], rate_limit_per_min: 0, enabled: true,
  };
  const session: AgentSession = {
    session_id: '123e4567-e89b-42d3-a456-426614174000',
    client_app_id: client.app_id,
    device_label: 'Mac mini',
    principal: { id: 'user-7', roles: [] },
    on_behalf_of: 'tenant-2:user-7',
    allowed_routes: ['orders'],
    created_at: '2026-01-01T00:00:00.000Z',
    access_expires_at: '2099-01-01T00:00:00.000Z',
    refresh_expires_at: '2099-01-30T00:00:00.000Z',
  };
  const ownJob: Job = {
    job_id: '223e4567-e89b-42d3-a456-426614174000', request_id: 'request-1', status: 'done',
    profile: 'general', project: '', source: 'agent:example-business', client_app_id: client.app_id,
    agent_session_id: session.session_id, on_behalf_of: session.on_behalf_of,
    input_preview: 'hello', metadata: {}, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:01.000Z',
  };
  const otherJob = { ...ownJob, job_id: '323e4567-e89b-42d3-a456-426614174000', agent_session_id: '423e4567-e89b-42d3-a456-426614174000' };
  const configStore = {
    agentAuth: { getSessionByAccessHash: async (hash: string) => hash === tokenHash(token) ? session : null },
    clients: { get: async () => client },
  } as unknown as ConfigStoreContract;
  const stateStore = {
    getJob: async (id: string) => id === ownJob.job_id ? ownJob : id === otherJob.job_id ? otherJob : null,
  } as unknown as RuntimeStateStore;
  const deps = {
    configStore,
    stateStore,
    isPaused: () => false,
    handleRun: async () => { throw new Error('run not expected'); },
  };

  const queryRes = new FakeResponse();
  await handleAgentApiHttpFor(deps, request('GET'), queryRes as unknown as ServerResponse, new URL(`https://hub.example.com/agent-api/v1/jobs/${ownJob.job_id}?token=${token}`));
  assert.equal(queryRes.statusCode, 401);

  const ownRes = new FakeResponse();
  await handleAgentApiHttpFor(deps, request('GET', { authorization: `Bearer ${token}` }), ownRes as unknown as ServerResponse, new URL(`https://hub.example.com/agent-api/v1/jobs/${ownJob.job_id}`));
  assert.equal(ownRes.statusCode, 200);
  assert.equal(ownRes.json()['job_id'], ownJob.job_id);

  const otherRes = new FakeResponse();
  await handleAgentApiHttpFor(deps, request('GET', { authorization: `Bearer ${token}` }), otherRes as unknown as ServerResponse, new URL(`https://hub.example.com/agent-api/v1/jobs/${otherJob.job_id}`));
  assert.equal(otherRes.statusCode, 404);
});

test('Agent Tool API: envelope 严格拒绝非对象 arguments 与字段漂移', async () => {
  const token = `bha_${'b'.repeat(43)}`;
  const client: Client = {
    app_id: 'example-business', name: 'Example Business', token: 'client-token',
    agent_authorize_url: 'https://tenant.example.com/agent-authorize',
    allowed_routes: ['orders'], allowed_channels: [], rate_limit_per_min: 0, enabled: true,
  };
  const session: AgentSession = {
    session_id: '523e4567-e89b-42d3-a456-426614174000', client_app_id: client.app_id, device_label: 'Mac mini',
    principal: { id: 'user-7', roles: [] }, on_behalf_of: 'tenant-2:user-7', allowed_routes: ['orders'],
    created_at: '2026-01-01T00:00:00.000Z', access_expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-01-30T00:00:00.000Z',
  };
  const deps = {
    configStore: {
      agentAuth: { getSessionByAccessHash: async (hash: string) => hash === tokenHash(token) ? session : null },
      clients: { get: async () => client },
    } as unknown as ConfigStoreContract,
    stateStore: {} as RuntimeStateStore,
    isPaused: () => false,
    handleRun: async () => { throw new Error('run not expected'); },
    toolProxyDeps: {} as ToolProxyDeps,
  };
  const base = {
    invocation_id: 'a'.repeat(64),
    route: 'orders',
    capability_revision: 'b'.repeat(64),
    agent_run_id: '623e4567-e89b-42d3-a456-426614174000',
    tool: 'order_list',
    arguments: {},
  };
  const headers = { authorization: `Bearer ${token}` };

  for (const invalidBody of [[], null, 'x', 7]) {
    const res = new FakeResponse();
    await handleAgentApiHttpFor(deps, request('POST', headers, invalidBody), res as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/tool-invocations'));
    assert.equal(res.statusCode, 400);
    assert.equal(res.json()['error'], 'invalid_request');
  }

  for (const invalid of [[], null, 'x', 7]) {
    const res = new FakeResponse();
    await handleAgentApiHttpFor(deps, request('POST', headers, { ...base, arguments: invalid }), res as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/tool-invocations'));
    assert.equal(res.statusCode, 400);
    assert.equal(res.json()['error'], 'invalid_request');
  }

  const missing = new FakeResponse();
  const { tool: _tool, ...withoutTool } = base;
  await handleAgentApiHttpFor(deps, request('POST', headers, withoutTool), missing as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/tool-invocations'));
  assert.equal(missing.statusCode, 400);

  const extra = new FakeResponse();
  await handleAgentApiHttpFor(deps, request('POST', headers, { ...base, future: true }), extra as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/tool-invocations'));
  assert.equal(extra.statusCode, 400);

  const oversized = new FakeResponse();
  await handleAgentApiHttpFor(deps, request('POST', headers, { ...base, future: 'x'.repeat(20_000) }), oversized as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/tool-invocations'));
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json()['error'], 'arguments_too_large');

  for (const invalidBody of [[], null, 'x', 7]) {
    const res = new FakeResponse();
    await handleAgentApiHttpFor(deps, request('POST', headers, invalidBody), res as unknown as ServerResponse, new URL(`https://hub.example.com/agent-api/v1/tool-invocations/${'a'.repeat(64)}/resume`));
    assert.equal(res.statusCode, 400);
    assert.equal(res.json()['error'], 'invalid_request');
  }
});

test('Agent Tool API: pause 在读取请求与工具治理链前拦截 invoke/resume', async () => {
  const token = `bha_${'c'.repeat(43)}`;
  const client: Client = {
    app_id: 'example-business', name: 'Example Business', token: 'client-token',
    agent_authorize_url: 'https://tenant.example.com/agent-authorize',
    allowed_routes: ['orders'], allowed_channels: [], rate_limit_per_min: 0, enabled: true,
  };
  const session: AgentSession = {
    session_id: '723e4567-e89b-42d3-a456-426614174000', client_app_id: client.app_id, device_label: 'Mac mini',
    principal: { id: 'user-7', roles: [] }, on_behalf_of: 'tenant-2:user-7', allowed_routes: ['orders'],
    created_at: '2026-01-01T00:00:00.000Z', access_expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-01-30T00:00:00.000Z',
  };
  const deps = {
    configStore: {
      agentAuth: { getSessionByAccessHash: async (hash: string) => hash === tokenHash(token) ? session : null },
      clients: { get: async () => client },
    } as unknown as ConfigStoreContract,
    stateStore: {} as RuntimeStateStore,
    isPaused: () => true,
    handleRun: async () => { throw new Error('run not expected'); },
    toolProxyDeps: {} as ToolProxyDeps,
  };
  const headers = { authorization: `Bearer ${token}` };
  const invoke = new FakeResponse();
  await handleAgentApiHttpFor(deps, request('POST', headers, {
    invocation_id: 'd'.repeat(64), route: 'orders', capability_revision: 'e'.repeat(64),
    agent_run_id: '823e4567-e89b-42d3-a456-426614174000', tool: 'order_list', arguments: {},
  }), invoke as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/tool-invocations'));
  assert.equal(invoke.statusCode, 503);
  assert.equal(invoke.json()['status'], 'paused');
  assert.equal(invoke.json()['error'], 'hub_paused');

  const resume = new FakeResponse();
  await handleAgentApiHttpFor(deps, request('POST', headers, {}), resume as unknown as ServerResponse, new URL(`https://hub.example.com/agent-api/v1/tool-invocations/${'d'.repeat(64)}/resume`));
  assert.equal(resume.statusCode, 503);
  assert.equal(resume.json()['status'], 'paused');
  assert.equal(resume.json()['error'], 'hub_paused');
});

function runtimeHttpFixture() {
  const token = `bha_${'r'.repeat(43)}`;
  const client: Client = {
    app_id: 'example-business', name: 'Example Business', token: 'client-token',
    agent_authorize_url: 'https://tenant.example.com/agent-authorize',
    allowed_routes: ['allowed', 'audience-denied', 'agent-off', 'session-denied'], allowed_channels: [], rate_limit_per_min: 0, enabled: true,
  };
  const session: AgentSession = {
    session_id: '923e4567-e89b-42d3-a456-426614174000', client_app_id: client.app_id, device_label: 'Mac mini',
    principal: { id: 'user-7', roles: ['admin'] }, on_behalf_of: 'tenant-2:user-7',
    allowed_routes: ['allowed', 'audience-denied', 'agent-off', 'client-denied'],
    created_at: '2026-01-01T00:00:00.000Z', access_expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-01-30T00:00:00.000Z',
  };
  const baseRoute = (route_key: string): Route => ({
    route_key, name: route_key, enabled: true, target: 'llm', target_config: { credential: 'hidden', system_prompt: 'safe system' },
    profile: 'general', permission: 'full', session_policy: 'new', agent_client: { enabled: true, active_tool_limit: 1 },
    audience: { enabled: true, roles: ['admin'], clients: ['example-business'] },
    tools: { sources: [{ provider: 'business', allow: ['*'] }], agent_direct: { enabled: true } },
  });
  const routes = [
    baseRoute('allowed'),
    { ...baseRoute('audience-denied'), audience: { enabled: true, roles: ['owner'] } },
    { ...baseRoute('agent-off'), agent_client: { enabled: false } },
    baseRoute('session-denied'),
    baseRoute('client-denied'),
  ];
  const provider: ToolProvider = {
    name: 'business', base_url: 'https://business.invalid', secret: 'secret', spec_source: 'inline', enabled: true,
    log_payload: false, timeout_ms: 1000, rate_limit_per_min: 0, auto_refresh_min: 0,
    spec_json: JSON.stringify({ openapi: '3.0.0', info: { title: 'test', version: '1' }, paths: {
      '/staff': { get: { operationId: 'staff_list', summary: '查询员工', 'x-agent-capability': { version: 1, enabled: true, scope: 'staff.read', subject: { required: true } } } },
    } }),
  };
  let run: AgentClientRunRecord | null = null;
  let completeCalls = 0;
  const runtimeRepo = {
    resolveConversation: async () => 9,
    reserveRun: async (input: any) => {
      if (!run) run = {
        run_id: 'a23e4567-e89b-42d3-a456-426614174000', ...input, context: null, status: 'preparing',
        completion_hash: null, assistant_message_id: null, final_content: null, model: null, runtime: null, usage: null,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', completed_at: null,
      } as AgentClientRunRecord;
      return { run, created: !run.context };
    },
    finalizeTurn: async (input: any) => { run = { ...run!, context: input.context, status: 'context_ready' }; return run; },
    getRun: async () => run,
    findRunForInvocation: async () => run,
    completeRun: async (input: any) => {
      completeCalls++;
      if (!run?.context) throw new Error('turn context is not ready');
      if (run.completion_hash) return { run, created: false };
      run = {
        ...run,
        completion_hash: input.completion_hash,
        assistant_message_id: input.assistant_message_id,
        final_content: input.assistant_output,
        status: input.status,
        model: input.model ?? null,
        runtime: input.runtime ?? null,
        usage: input.usage ?? null,
        completed_at: '2026-01-01T00:01:00.000Z',
      };
      return { run, created: true };
    },
  };
  const configStore = {
    agentAuth: { getSessionByAccessHash: async (value: string) => value === tokenHash(token) ? session : null },
    clients: { get: async () => client },
    routes: { list: async () => routes, get: async (key: string) => routes.find((route) => route.route_key === key) ?? null },
    toolProviders: { get: async () => provider },
    conversations: { getThreadMemory: async () => ({ summary: null, summary_upto_id: 0 }), recentMessagesAfter: async () => [] },
    agentClientRuntime: runtimeRepo,
  } as unknown as ConfigStoreContract;
  const stateStore = { appendAudit: async () => undefined } as unknown as RuntimeStateStore;
  const toolProxyDeps: ToolProxyDeps = {
    cfg: {} as AppConfig, configStore, stateStore, toolIndex: null, now: () => '2026-01-01T00:00:00.000Z', sleep: async () => undefined,
  };
  return {
    token,
    deps: { configStore, stateStore, isPaused: () => false, handleRun: async () => undefined, toolProxyDeps, kbService: null },
    completeCalls: () => completeCalls,
  };
}

test('Agent Runtime HTTP: workspace 只列授权交集，turn 可省 page_context/renderers 且拒绝未知字段', async () => {
  const fx = runtimeHttpFixture();
  const headers = { authorization: `Bearer ${fx.token}` };
  const workspaces = new FakeResponse();
  await handleAgentApiHttpFor(fx.deps, request('GET', headers), workspaces as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/workspaces'));
  assert.equal(workspaces.statusCode, 200);
  assert.deepEqual((workspaces.json()['workspaces'] as Array<{ route: string }>).map((item) => item.route), ['allowed']);

  const turn = new FakeResponse();
  await handleAgentApiHttpFor(fx.deps, request('POST', headers, {
    client_conversation_id: 'c1', client_turn_id: 't1', user_message_id: 'm1', user_input: '查询员工',
  }), turn as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/workspaces/allowed/turns'));
  assert.equal(turn.statusCode, 200, JSON.stringify(turn.json()));
  assert.equal(turn.json()['schema_version'], 'bailing.agent-turn-context.v1');

  const unknown = new FakeResponse();
  await handleAgentApiHttpFor(fx.deps, request('POST', headers, {
    client_conversation_id: 'c2', client_turn_id: 't2', user_message_id: 'm2', user_input: '查询员工', future: true,
  }), unknown as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/workspaces/allowed/turns'));
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json()['error'], 'invalid_request');
});

test('Agent Runtime HTTP: complete 拒绝 hidden reasoning 且不触达 repository', async () => {
  const fx = runtimeHttpFixture();
  const res = new FakeResponse();
  await handleAgentApiHttpFor(fx.deps, request('POST', { authorization: `Bearer ${fx.token}` }, {
    assistant_message_id: 'a1', status: 'completed', content: 'done', hidden_reasoning: 'secret chain of thought',
  }), res as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/runs/a23e4567-e89b-42d3-a456-426614174000/complete'));
  assert.equal(res.statusCode, 400);
  assert.equal(fx.completeCalls(), 0);
});

test('Agent Runtime HTTP: 64000 个中文字符可穿过字节上限完成 turn 与 complete', async () => {
  const fx = runtimeHttpFixture();
  const headers = { authorization: `Bearer ${fx.token}` };
  const boundaryText = '中'.repeat(64_000);
  const turnBody = {
    client_conversation_id: 'c-boundary', client_turn_id: 't-boundary', user_message_id: 'm-boundary', user_input: boundaryText,
    page_context: { title: '中文边界' }, renderers: ['markdown'],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(turnBody), 'utf8') > 96 * 1024);
  const turn = new FakeResponse();
  await handleAgentApiHttpFor(fx.deps, request('POST', headers, turnBody), turn as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/workspaces/allowed/turns'));
  assert.equal(turn.statusCode, 200, JSON.stringify(turn.json()));

  const completionBody = { assistant_message_id: 'a-boundary', status: 'completed', content: boundaryText };
  assert.ok(Buffer.byteLength(JSON.stringify(completionBody), 'utf8') > 80 * 1024);
  const complete = new FakeResponse();
  await handleAgentApiHttpFor(fx.deps, request('POST', headers, completionBody), complete as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/runs/a23e4567-e89b-42d3-a456-426614174000/complete'));
  assert.equal(complete.statusCode, 200, JSON.stringify(complete.json()));
  assert.equal(fx.completeCalls(), 1);
});

test('Agent Runtime HTTP: 客户端文本与 renderers 非法时 400，空搜索仅可通过 run 回退', async () => {
  const fx = runtimeHttpFixture();
  const headers = { authorization: `Bearer ${fx.token}` };
  const turnBase = { client_conversation_id: 'c1', client_turn_id: 't1', user_message_id: 'm1', user_input: '查询员工' };
  const invalidTurns = [
    { ...turnBase, user_input: '中'.repeat(64_001) },
    { ...turnBase, user_input: '查询\u0000员工' },
    { ...turnBase, renderers: Array.from({ length: 21 }, (_, index) => `renderer.${index}`) },
    { ...turnBase, renderers: ['markdown', 'markdown'] },
    { ...turnBase, renderers: ['invalid renderer'] },
  ];
  for (const body of invalidTurns) {
    const res = new FakeResponse();
    await handleAgentApiHttpFor(fx.deps, request('POST', headers, body), res as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/workspaces/allowed/turns'));
    assert.equal(res.statusCode, 400, JSON.stringify(res.json()));
  }

  const completionBase = { assistant_message_id: 'a1', status: 'completed', content: 'done' };
  const invalidCompletions = [
    { ...completionBase, content: '中'.repeat(64_001) },
    { ...completionBase, content: 'done\u0001' },
    { ...completionBase, model: 'm'.repeat(192) },
    { ...completionBase, model: 'model\u007f' },
    { ...completionBase, runtime: 'r'.repeat(192) },
    { ...completionBase, runtime: 'runtime\u0002' },
  ];
  for (const body of invalidCompletions) {
    const res = new FakeResponse();
    await handleAgentApiHttpFor(fx.deps, request('POST', headers, body), res as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/runs/a23e4567-e89b-42d3-a456-426614174000/complete'));
    assert.equal(res.statusCode, 400, JSON.stringify(res.json()));
  }
  assert.equal(fx.completeCalls(), 0);

  for (const body of [{}, { query: ' \n\t ' }]) {
    const res = new FakeResponse();
    await handleAgentApiHttpFor(fx.deps, request('POST', headers, body), res as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/workspaces/allowed/capabilities/search'));
    assert.equal(res.statusCode, 400, JSON.stringify(res.json()));
  }

  const turn = new FakeResponse();
  await handleAgentApiHttpFor(fx.deps, request('POST', headers, turnBase), turn as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/workspaces/allowed/turns'));
  assert.equal(turn.statusCode, 200, JSON.stringify(turn.json()));
  const search = new FakeResponse();
  await handleAgentApiHttpFor(fx.deps, request('POST', headers, { run_id: 'a23e4567-e89b-42d3-a456-426614174000' }), search as unknown as ServerResponse, new URL('https://hub.example.com/agent-api/v1/workspaces/allowed/capabilities/search'));
  assert.equal(search.statusCode, 200, JSON.stringify(search.json()));
  assert.equal(search.json()['query'], '查询员工');
});
