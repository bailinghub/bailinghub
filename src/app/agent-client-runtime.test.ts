import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { AgentSession, Client, Route, ToolProvider } from '../core/contracts/types';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { AgentClientRunRecord } from '../infrastructure/config/config-agent-client-runtime-repository';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ToolProxyDeps } from './tool-proxy';
import { AgentToolApiError, listAgentToolsFor } from './agent-tool-invocations';
import { completeAgentRunFor, getAgentWorkspaceBootstrapFor, prepareAgentTurnFor, searchAgentCapabilitiesFor, type AgentClientRuntimeDeps } from './agent-client-runtime';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';

function spec(): string {
  const acc = (scope: string) => ({ 'x-agent-capability': { version: 1, enabled: true, scope, subject: { required: true } } });
  return JSON.stringify({ openapi: '3.0.0', info: { title: 'test', version: '1' }, paths: {
    '/staff': { get: { operationId: 'staff_list', summary: '查询员工', ...acc('tenant.staff.read') } },
    '/orders': { get: { operationId: 'order_list', summary: '查询订单', ...acc('tenant.order.read') } },
  } });
}

function route(): Route {
  return {
    route_key: 'tenant-agent', name: '门店助手', description: '本地业务助手', enabled: true,
    target: 'llm', target_config: { credential: 'never-return-this', model: 'never-return-model', system_prompt: '只按业务规则回答' },
    profile: 'general', permission: 'full', session_policy: 'new',
    agent_client: { enabled: true, instructions: '先确认再执行', active_tool_limit: 2 },
    audience: { enabled: true, clients: ['digital-cloud'], roles: ['admin'] },
    memory: { recent_messages: 5 },
    tools: { sources: [{ provider: 'business', allow: ['*'] }], max_calls: 4, agent_direct: { enabled: true } },
  };
}

function auth(): { client: Client; session: AgentSession } {
  return {
    client: { app_id: 'digital-cloud', name: 'Digital Cloud', token: 'hidden', allowed_routes: ['tenant-agent'], allowed_channels: [], rate_limit_per_min: 0, enabled: true },
    session: {
      session_id: SESSION_ID, client_app_id: 'digital-cloud', device_label: 'test', principal: { id: 'u1', roles: ['admin'] },
      on_behalf_of: 'tenant:u1', allowed_routes: ['tenant-agent'], created_at: '2026-01-01T00:00:00.000Z',
      access_expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-02-01T00:00:00.000Z',
    },
  };
}

function fixture() {
  let currentRoute = route();
  let userWrites = 0;
  let assistantWrites = 0;
  let run: AgentClientRunRecord | null = null;
  const provider: ToolProvider = {
    name: 'business', base_url: 'https://secret-business.example.com', secret: 'provider-secret', spec_source: 'inline', spec_json: spec(),
    enabled: true, log_payload: false, timeout_ms: 1000, rate_limit_per_min: 0, auto_refresh_min: 0,
  };
  const repo = {
    resolveConversation: async () => 7,
    reserveRun: async (input: any) => {
      if (!run) {
        run = {
          run_id: RUN_ID, ...input, context: null, status: 'preparing', completion_hash: null, assistant_message_id: null,
          final_content: null, model: null, runtime: null, usage: null,
          created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', completed_at: null,
        } as AgentClientRunRecord;
        return { run, created: true };
      }
      if (run.request_hash !== input.request_hash) throw new Error('unexpected conflict');
      return { run, created: false };
    },
    finalizeTurn: async (input: any) => {
      if (!run) throw new Error('missing run');
      if (!run.context) { userWrites++; run = { ...run, context: input.context, status: 'context_ready' }; }
      return run;
    },
    getRun: async () => run,
    findRunForInvocation: async () => run,
    completeRun: async (input: any) => {
      if (!run) throw new Error('missing run');
      if (run.completion_hash) {
        if (run.completion_hash !== input.completion_hash) {
          const { AgentClientRuntimeConflictError } = await import('../infrastructure/config/config-agent-client-runtime-repository');
          throw new AgentClientRuntimeConflictError('immutable');
        }
        return { run, created: false };
      }
      assistantWrites++;
      run = { ...run, completion_hash: input.completion_hash, assistant_message_id: input.assistant_message_id, final_content: input.assistant_output, status: input.status, completed_at: '2026-01-01T00:01:00.000Z' };
      return { run, created: true };
    },
  };
  const config = {
    routes: { get: async () => currentRoute, list: async () => [currentRoute] },
    toolProviders: { get: async () => provider },
    conversations: {
      getThreadMemory: async () => ({ summary: '之前讨论员工', summary_upto_id: 2 }),
      recentMessagesAfter: async () => [{ direction: 'out', channel: 'hub', content: '上一条回复', created_at: '2026-01-01T00:00:00.000Z' }],
    },
    agentClientRuntime: repo,
  } as unknown as ConfigStoreContract;
  const stateStore = { appendAudit: async () => undefined } as unknown as RuntimeStateStore;
  const toolProxyDeps: ToolProxyDeps = {
    cfg: { toolRetrieval: {} } as AppConfig, configStore: config, stateStore, toolIndex: null,
    now: () => '2026-01-01T00:00:00.000Z', sleep: async () => undefined,
  };
  const deps: AgentClientRuntimeDeps = { toolProxyDeps, kbService: null, stateStore };
  return { deps, repo, setRoute: (value: Route) => { currentRoute = value; }, counts: () => ({ userWrites, assistantWrites }) };
}

test('Agent Runtime bootstrap 只返回安全字段并声明本地规划治理边界', async () => {
  const fx = fixture();
  const bootstrap = await getAgentWorkspaceBootstrapFor(fx.deps, auth(), 'tenant-agent');
  assert.equal(bootstrap['schema_version'], 'bailing.agent-runtime-profile.v1');
  const encoded = JSON.stringify(bootstrap);
  assert.match(encoded, /只按业务规则回答/);
  assert.match(encoded, /先确认再执行/);
  assert.doesNotMatch(encoded, /never-return-this|never-return-model|provider-secret|secret-business/);
  const profile = bootstrap['profile'] as Record<string, any>;
  assert.equal(profile.governance.planner, 'local_agent');
  assert.equal(profile.governance.hidden_reasoning_sync, false);
  assert.equal(profile.governance.max_tool_calls, 4);
});

test('Agent Runtime turn 先装配旧记忆、主动工具封顶且幂等写一条 user message', async () => {
  const fx = fixture();
  const input = { client_conversation_id: 'c1', client_turn_id: 't1', user_message_id: 'm1', user_input: '查询员工 Ada' };
  const first = await prepareAgentTurnFor(fx.deps, auth(), 'tenant-agent', input);
  const replay = await prepareAgentTurnFor(fx.deps, auth(), 'tenant-agent', input);
  assert.deepEqual(replay, first);
  assert.equal(fx.counts().userWrites, 1);
  assert.equal((first['active_tools'] as unknown[]).length, 2);
  const context = first['context'] as Record<string, any>;
  assert.equal(context.memory.recent.length, 1);
  assert.equal(context.governance.authorization, 'server_revalidated');
});

test('Agent Runtime turn 对超长、控制字符和非法 renderers 严格失败而不静默改写', async () => {
  const fx = fixture();
  const base = { client_conversation_id: 'c1', client_turn_id: 't1', user_message_id: 'm1', user_input: '查询员工' };
  const badRequest = (error: unknown) => error instanceof AgentToolApiError && error.statusCode === 400;

  for (const user_input of ['x'.repeat(64_001), '查询\u0000员工']) {
    await assert.rejects(prepareAgentTurnFor(fx.deps, auth(), 'tenant-agent', { ...base, user_input }), badRequest);
  }
  const invalidRenderers = [
    Array.from({ length: 21 }, (_, index) => `renderer.${index}`),
    ['markdown', 'markdown'],
    ['markdown', 'invalid renderer'],
  ];
  for (const renderers of invalidRenderers) {
    await assert.rejects(prepareAgentTurnFor(fx.deps, auth(), 'tenant-agent', { ...base, renderers }), badRequest);
  }
  assert.deepEqual(fx.counts(), { userWrites: 0, assistantWrites: 0 });
});

test('Agent Runtime complete 冻结 assistant_message_id/content/status/usage 并幂等回放', async () => {
  const fx = fixture();
  await prepareAgentTurnFor(fx.deps, auth(), 'tenant-agent', { client_conversation_id: 'c1', client_turn_id: 't1', user_message_id: 'm1', user_input: '查询员工' });
  const completion = { assistant_message_id: 'a1', status: 'completed' as const, content: '已完成', usage: { total_tokens: 9 } };
  assert.equal((await completeAgentRunFor(fx.deps, auth(), RUN_ID, completion))['idempotent_replay'], false);
  assert.equal((await completeAgentRunFor(fx.deps, auth(), RUN_ID, completion))['idempotent_replay'], true);
  assert.equal(fx.counts().assistantWrites, 1);
  await assert.rejects(
    completeAgentRunFor(fx.deps, auth(), RUN_ID, { ...completion, assistant_message_id: 'a2' }),
    (error) => error instanceof AgentToolApiError && error.statusCode === 409,
  );
});

test('Agent Runtime complete 对超长和控制字符正文、模型、运行时严格返回 400', async () => {
  const fx = fixture();
  const base = { assistant_message_id: 'a1', status: 'completed' as const, content: '已完成' };
  const invalid = [
    { ...base, content: 'x'.repeat(64_001) },
    { ...base, content: '完成\u0001' },
    { ...base, model: 'm'.repeat(192) },
    { ...base, model: 'model\u007f' },
    { ...base, runtime: 'r'.repeat(192) },
    { ...base, runtime: 'runtime\u0002' },
  ];
  for (const completion of invalid) {
    await assert.rejects(
      completeAgentRunFor(fx.deps, auth(), RUN_ID, completion),
      (error) => error instanceof AgentToolApiError && error.statusCode === 400,
    );
  }
  assert.equal(fx.counts().assistantWrites, 0);
});

test('agent_client.enabled=false 只关闭新 Runtime，旧 Agent tools catalog 仍兼容', async () => {
  const fx = fixture();
  fx.setRoute({ ...route(), agent_client: { enabled: false } });
  await assert.rejects(
    getAgentWorkspaceBootstrapFor(fx.deps, auth(), 'tenant-agent'),
    (error) => error instanceof AgentToolApiError && error.code === 'agent_client_disabled',
  );
  assert.equal((await listAgentToolsFor(fx.deps.toolProxyDeps, auth(), 'tenant-agent')).tools.length, 2);
});

test('capability search 在 embedding 不可用时整体确定性 lexical 回退', async () => {
  const fx = fixture();
  fx.deps.toolProxyDeps.toolIndex = { retrieve: async () => { throw new Error('embedding down'); } } as any;
  const first = await searchAgentCapabilitiesFor(fx.deps, auth(), 'tenant-agent', { query: '员工', limit: 2 });
  const second = await searchAgentCapabilitiesFor(fx.deps, auth(), 'tenant-agent', { query: '员工', limit: 2 });
  assert.equal(first['schema_version'], 'bailing.agent-capability-search.v1');
  assert.deepEqual(first, second);
  assert.equal((first['tools'] as Array<{ name: string }>)[0]?.name, 'staff_list');
});

test('capability search 空 query 必须绑定合法 run，且可回退到该 run 的 user_input', async () => {
  const fx = fixture();
  for (const input of [{}, { query: ' \n\t ' }]) {
    await assert.rejects(
      searchAgentCapabilitiesFor(fx.deps, auth(), 'tenant-agent', input),
      (error) => error instanceof AgentToolApiError && error.statusCode === 400,
    );
  }
  await prepareAgentTurnFor(fx.deps, auth(), 'tenant-agent', {
    client_conversation_id: 'c1', client_turn_id: 't1', user_message_id: 'm1', user_input: '查询员工 Ada',
  });
  const fallback = await searchAgentCapabilitiesFor(fx.deps, auth(), 'tenant-agent', { run_id: RUN_ID });
  assert.equal(fallback['query'], '查询员工 Ada');
  assert.equal((fallback['tools'] as Array<{ name: string }>)[0]?.name, 'staff_list');
});
