import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '../app/auth';
import type { AppConfig } from '../core/config/config';
import type { RuntimeContext } from '../core/edition';
import type { AgentSession, Client, Job, Route, ToolApproval } from '../core/contracts/types';
import type { LaunchSpec } from '../core/runtime/launch-runtime';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { handleRunFor, type RunApiDeps } from './run';
import { handleApprovalDecisionFor, type ApprovalDecisionDeps } from './approvals';
import { handleExecutorResultFor, type ExecutorApiDeps } from './executor';

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string | number | string[]> = {};
  body: Uint8Array = Buffer.alloc(0);

  writeHead(code: number, headers?: Record<string, string | number | string[]>): void {
    this.statusCode = code;
    if (headers) Object.assign(this.headers, headers);
  }

  setHeader(name: string, value: string | number | string[]): void {
    this.headers[name.toLowerCase()] = value;
  }

  end(chunk?: string | Buffer): void {
    if (chunk) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }

  json(): Record<string, unknown> {
    return JSON.parse(Buffer.from(this.body).toString('utf8')) as Record<string, unknown>;
  }
}

function jsonRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  stream.method = 'POST';
  stream.headers = headers;
  return stream;
}

function runtimeContext(requestId: string, source: RuntimeContext['source']): RuntimeContext {
  return {
    edition: 'oss',
    scope: { kind: 'single', id: 'default', capabilities: ['single_org'] },
    actor: { kind: 'system', id: 'test', roles: ['system'] },
    requestId,
    source,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    job_id: 'job-1',
    request_id: 'req-1',
    status: 'queued',
    target: 'llm',
    profile: 'general',
    project: '',
    source: 'client-a',
    input_preview: 'hello',
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const client: Client = {
  app_id: 'client-a',
  name: 'Client A',
  token: 'client-token',
  allowed_routes: ['orders'],
  allowed_channels: [],
  rate_limit_per_min: 0,
  enabled: true,
};
const clientPrincipal: Principal = { kind: 'client', client };

function runDeps(state: Partial<RuntimeStateStore>, config: Partial<ConfigStoreContract> | null): RunApiDeps {
  return {
    cfg: { defaultProfile: 'general' },
    isPaused: () => false,
    runtimeContextFor: async ({ requestId }) => runtimeContext(requestId, 'run'),
    runtimeStoresFor: () => ({
      state: state as RuntimeStateStore,
      config: config as ConfigStoreContract | null,
    }),
    resolveProjectPathFor: async () => null,
    engineForContext: () => ({ launchJob: async () => { throw new Error('launchJob should not be called'); } }),
  };
}

test('POST /run: 接入方不能覆盖路由决定的 project/profile', async () => {
  const res = new FakeResponse();
  await handleRunFor(
    runDeps({}, null),
    jsonRequest({ request_id: 'req-override', input: 'hello', route: 'orders', project: 'private', profile: 'admin' }),
    res as unknown as ServerResponse,
    clientPrincipal,
  );

  assert.equal(res.statusCode, 403);
  assert.match(String(res.json()['error']), /不可覆盖 project\/profile/);
});

test('POST /run: 接入方 route 必须符合公开 Client API 约束', async () => {
  const res = new FakeResponse();
  await handleRunFor(
    runDeps({}, null),
    jsonRequest({ request_id: 'req-invalid-route', input: 'hello', route: 'Orders' }),
    res as unknown as ServerResponse,
    clientPrincipal,
  );

  assert.equal(res.statusCode, 400);
  assert.match(String(res.json()['error']), /route 必须匹配/);
});

test('POST /run: 接入方 route 不能超过公开 Client API 长度上限', async () => {
  const res = new FakeResponse();
  await handleRunFor(
    runDeps({}, null),
    jsonRequest({
      request_id: 'req-route-too-long',
      input: 'hello',
      route: `a${'b'.repeat(64)}`,
    }),
    res as unknown as ServerResponse,
    clientPrincipal,
  );

  assert.equal(res.statusCode, 400);
  assert.match(String(res.json()['error']), /route 必须匹配/);
});

test('POST /run: 接入方不能提交公开 Client API 未声明的 source 字段', async () => {
  const res = new FakeResponse();

  await handleRunFor(
    runDeps({}, null),
    jsonRequest({ request_id: 'req-source', input: 'hello', route: 'orders', source: 'spoofed-client' }),
    res as unknown as ServerResponse,
    clientPrincipal,
  );

  assert.equal(res.statusCode, 400);
  assert.match(String(res.json()['error']), /未声明字段: source/);
});

test('POST /run: request_id 不能跨接入方碰撞', async () => {
  const route: Route = {
    route_key: 'orders',
    name: 'Orders',
    enabled: true,
    target: 'llm',
    target_config: {},
    profile: 'general',
    session_policy: 'new',
  };
  const config = {
    routes: { get: async () => route },
    conversations: { resolveSession: async () => ({ sessionId: 'session-1', isContinue: false, scopeKey: 'request:req-1' }) },
    targets: { list: async () => [] },
    clients: { touch: async () => undefined },
  } as unknown as ConfigStoreContract;
  const state = {
    findByRequestId: async () => job({ request_id: 'shared-request', client_app_id: 'client-b' }),
  } as unknown as RuntimeStateStore;
  const res = new FakeResponse();

  await handleRunFor(
    runDeps(state, config),
    jsonRequest({ request_id: 'shared-request', input: 'hello', route: 'orders' }),
    res as unknown as ServerResponse,
    clientPrincipal,
  );

  assert.equal(res.statusCode, 409);
  assert.match(String(res.json()['error']), /其他接入方冲突/);
});

test('POST /agent-api/v1/run: 业务主体和 Agent Session 由服务端注入，metadata 不能劫持', async () => {
  const route: Route = {
    route_key: 'orders',
    name: 'Orders',
    enabled: true,
    target: 'llm',
    target_config: {},
    profile: 'general',
    session_policy: 'per_key',
    session_key_field: 'arbitrary_user_key',
  };
  const session: AgentSession = {
    session_id: '123e4567-e89b-42d3-a456-426614174000',
    client_app_id: client.app_id,
    device_label: 'Mac mini',
    principal: { id: 'user-7', tenant: 'tenant-2', roles: ['manager'], audience: 'employee' },
    on_behalf_of: 'tenant-2:user-7',
    allowed_routes: ['orders'],
    created_at: '2026-01-01T00:00:00.000Z',
    access_expires_at: '2026-01-01T01:00:00.000Z',
    refresh_expires_at: '2026-02-01T00:00:00.000Z',
  };
  const agentPrincipal: Principal = { kind: 'agent', client, session };
  let trustedScope: string | null = null;
  let launch: LaunchSpec | null = null;
  const config = {
    routes: { get: async () => route },
    conversations: {
      resolveSession: async () => { throw new Error('Agent per_key must not resolve from metadata'); },
      sessionForScope: async (routeKey: string, scopeKey: string) => {
        assert.equal(routeKey, route.route_key);
        trustedScope = scopeKey;
        return { sessionId: 'brain-session-1', isContinue: true, scopeKey };
      },
    },
    targets: { list: async () => [] },
    clients: { touch: async () => undefined },
    rateLimits: { consume: async () => false },
  } as unknown as ConfigStoreContract;
  const state = { findByRequestId: async () => null } as unknown as RuntimeStateStore;
  const deps: RunApiDeps = {
    cfg: { defaultProfile: 'general' },
    isPaused: () => false,
    runtimeContextFor: async ({ requestId }) => runtimeContext(requestId, 'run'),
    runtimeStoresFor: () => ({ state, config }),
    resolveProjectPathFor: async () => null,
    engineForContext: () => ({
      launchJob: async (spec) => {
        launch = spec;
        return job({
          job_id: 'job-agent',
          request_id: spec.requestId,
          client_app_id: client.app_id,
          agent_session_id: spec.agentAttribution?.agentSessionId,
          on_behalf_of: spec.agentAttribution?.onBehalfOf,
          metadata: spec.metadata,
        });
      },
    }),
  };
  const res = new FakeResponse();
  await handleRunFor(
    deps,
    jsonRequest({
      request_id: 'agent-request-1',
      route: 'orders',
      input: 'query orders',
      metadata: {
        custom_hint: 'keep-me',
        principal: { id: 'attacker', roles: ['admin'] },
        subject: { id: 'attacker-2' },
        visitor_uid: 'attacker',
        operator_uid: 'attacker',
        tenant: 'other-tenant',
        roles: ['admin'],
        session_id: 'hijacked-brain-session',
        arbitrary_user_key: 'victim-history-scope',
        on_behalf_of: 'attacker',
        agent_session_id: 'attacker-session',
        source: 'forged',
      },
    }),
    res as unknown as ServerResponse,
    agentPrincipal,
  );

  assert.equal(res.statusCode, 202);
  assert.match(trustedScope ?? '', /^agent-subject:[a-f0-9]{64}$/);
  assert.notEqual(trustedScope, 'victim-history-scope');
  const firstClientScope = trustedScope ?? '';
  assert.ok(launch);
  const launchSpec = launch as unknown as LaunchSpec;
  assert.equal(launchSpec.metadata['visitor_uid'], session.on_behalf_of);
  assert.equal(launchSpec.metadata['operator_uid'], session.on_behalf_of);
  assert.equal(launchSpec.metadata['session_id'], undefined);
  assert.equal(launchSpec.metadata['tenant'], undefined);
  assert.equal((launchSpec.metadata['principal'] as Record<string, unknown>)['id'], session.principal.id);
  assert.equal((launchSpec.metadata['principal'] as Record<string, unknown>)['tenant'], session.principal.tenant);
  assert.deepEqual((launchSpec.metadata['principal'] as Record<string, unknown>)['roles'], session.principal.roles);
  assert.equal(launchSpec.metadata['custom_hint'], 'keep-me');
  assert.equal(launchSpec.source, `agent:${client.app_id}`);
  assert.equal(launchSpec.callbackUrl, undefined);
  assert.deepEqual(launchSpec.agentAttribution, {
    agentSessionId: session.session_id,
    clientAppId: client.app_id,
    subjectId: 'user-7',
    businessTenantRef: 'tenant-2',
    onBehalfOf: session.on_behalf_of,
  });

  const otherClient: Client = { ...client, app_id: 'client-b', name: 'Client B', token: 'other-client-token' };
  const otherSession: AgentSession = {
    ...session,
    session_id: '223e4567-e89b-42d3-a456-426614174000',
    client_app_id: otherClient.app_id,
  };
  const otherRes = new FakeResponse();
  await handleRunFor(
    deps,
    jsonRequest({
      request_id: 'agent-request-other-client',
      route: 'orders',
      input: 'same subject, another client',
      metadata: { arbitrary_user_key: 'victim-history-scope' },
    }),
    otherRes as unknown as ServerResponse,
    { kind: 'agent', client: otherClient, session: otherSession },
  );
  assert.equal(otherRes.statusCode, 202);
  assert.match(trustedScope ?? '', /^agent-subject:[a-f0-9]{64}$/);
  assert.notEqual(trustedScope, firstClientScope, '同 route 下不同 Client 的同名主体不得共用会话 scope');
});

test('POST /agent-api/v1/run: fixed 与 passthrough 会话策略对 Agent 失败关闭', async (t) => {
  const session: AgentSession = {
    session_id: '123e4567-e89b-42d3-a456-426614174000',
    client_app_id: client.app_id,
    device_label: 'Mac mini',
    principal: { id: 'user-7', tenant: 'tenant-2', roles: ['manager'] },
    on_behalf_of: 'tenant-2:user-7',
    allowed_routes: ['orders'],
    created_at: '2026-01-01T00:00:00.000Z',
    access_expires_at: '2026-01-01T01:00:00.000Z',
    refresh_expires_at: '2026-02-01T00:00:00.000Z',
  };
  const agentPrincipal: Principal = { kind: 'agent', client, session };
  for (const policy of ['fixed', 'passthrough'] as const) {
    await t.test(policy, async () => {
      const route: Route = {
        route_key: 'orders', name: 'Orders', enabled: true, target: 'llm', target_config: {}, profile: 'general',
        session_policy: policy,
        ...(policy === 'fixed' ? { session_fixed_id: 'shared-session' } : { session_key_field: 'session_id' }),
      };
      const config = {
        routes: { get: async () => route },
        conversations: { resolveSession: async () => { throw new Error('unsafe session resolver must not run'); } },
        targets: { list: async () => [] },
        clients: { touch: async () => undefined },
        rateLimits: { consume: async () => false },
      } as unknown as ConfigStoreContract;
      const res = new FakeResponse();
      await handleRunFor(
        runDeps({ findByRequestId: async () => null } as unknown as RuntimeStateStore, config),
        jsonRequest({
          request_id: `agent-${policy}`,
          route: 'orders',
          input: 'query orders',
          metadata: { session_id: 'victim-session' },
        }),
        res as unknown as ServerResponse,
        agentPrincipal,
      );
      assert.equal(res.statusCode, 403);
      assert.match(String(res.json()['error']), new RegExp(`session_policy=${policy}`));
    });
  }
});

function approval(status: ToolApproval['status'] = 'pending'): ToolApproval {
  return {
    id: 7,
    job_id: 'job-1',
    request_id: 'req-1',
    provider: 'orders',
    tool: 'refund_create',
    scope: 'refund.create',
    risk: 'high',
    args_hash: 'hash-1',
    status,
    ...(status === 'approved' ? { decision_id: 'decision-1' } : {}),
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function approvalBody(): Record<string, unknown> {
  return {
    kind: 'tool_approval_decision',
    schema_version: 'bailing.approval-decision.v1',
    approval_id: 7,
    job_id: 'job-1',
    request_id: 'req-1',
    args_hash: 'hash-1',
    decision: 'approved',
    decision_id: 'decision-1',
    approver: 'operator-1',
  };
}

function approvalDeps(item: ToolApproval): ApprovalDecisionDeps {
  const configStore = {
    approvals: {
      get: async () => item,
      getByDecisionId: async () => null,
      decide: async () => { throw new Error('decide should not be called'); },
    },
  } as unknown as ConfigStoreContract;
  const stateStore = { getJob: async () => job({ status: 'done', client_app_id: 'client-a' }) } as unknown as RuntimeStateStore;
  return {
    cfg: { server: { token: 'admin-token' } } as unknown as AppConfig,
    configStore,
    stateStore,
    now: () => '2026-01-01T00:00:00.000Z',
    sleep: async () => undefined,
    secretForJob: async () => 'approval-secret',
    engineRuntime: { requeueForRerun: async () => { throw new Error('rerun should not be called'); } },
  };
}

test('审批决策: 无授权 token 或有效签名时拒绝裁决', async () => {
  const res = new FakeResponse();
  await handleApprovalDecisionFor(
    approvalDeps(approval()),
    jsonRequest(approvalBody()),
    res as unknown as ServerResponse,
    7,
    new URL('http://local/approvals/7/decision'),
  );

  assert.equal(res.statusCode, 401);
});

test('审批决策: 同一 decision_id 的同一决策幂等返回', async () => {
  const res = new FakeResponse();
  await handleApprovalDecisionFor(
    approvalDeps(approval('approved')),
    jsonRequest(approvalBody(), { authorization: 'Bearer admin-token' }),
    res as unknown as ServerResponse,
    7,
    new URL('http://local/approvals/7/decision'),
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.json()['idempotent'], true);
  assert.equal(res.json()['rerun'], false);
});

test('审批决策: 普通任务伪造 direct metadata 仍按原模型任务重跑', async () => {
  let reruns = 0;
  const item = approval();
  const forged = job({
    status: 'done',
    target: 'llm',
    client_app_id: 'client-a',
    agent_session_id: '123e4567-e89b-42d3-a456-426614174000',
    on_behalf_of: 'tenant-1:user-7',
    session_id: '223e4567-e89b-42d3-a456-426614174000',
    source: 'agent:client-a',
    dispatch: { route_key: 'orders' },
    metadata: {
      agent_tool_job_marker: 'bailing.agent-tool-job.v1',
      agent_tool_call_v1: true,
      agent_invocation_id: 'a'.repeat(64),
      agent_run_id: '223e4567-e89b-42d3-a456-426614174000',
      agent_route: 'orders',
      agent_tool: 'refund_create',
      agent_args_hash: 'b'.repeat(64),
      agent_capability_revision: 'c'.repeat(64),
      agent_execution_fingerprint: 'd'.repeat(64),
    },
  });
  const deps: ApprovalDecisionDeps = {
    cfg: { server: { token: 'admin-token' } } as unknown as AppConfig,
    configStore: {
      approvals: {
        get: async () => item,
        getByDecisionId: async () => null,
        decide: async () => true,
      },
    } as unknown as ConfigStoreContract,
    stateStore: {
      getJob: async () => forged,
      appendAudit: async () => undefined,
    } as unknown as RuntimeStateStore,
    now: () => '2026-01-01T00:00:00.000Z',
    sleep: async () => undefined,
    secretForJob: async () => 'approval-secret',
    engineRuntime: { requeueForRerun: async () => { reruns++; } },
  };
  const res = new FakeResponse();
  await handleApprovalDecisionFor(
    deps,
    jsonRequest(approvalBody(), { authorization: 'Bearer admin-token' }),
    res as unknown as ServerResponse,
    7,
    new URL('http://local/approvals/7/decision'),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.json()['rerun'], true);
  assert.equal(reruns, 1);
});

test('执行器回报: 过期 claim_token 的迟到结果不会覆盖新认领任务', async () => {
  let finishCalls = 0;
  const state = {
    getJob: async () => job({ status: 'dispatched', claim_token: 'claim-new', executor_id: 'executor-new' }),
  } as unknown as RuntimeStateStore;
  const deps = {
    cfg: {} as AppConfig,
    toolIndex: null,
    isPaused: () => false,
    runtimeContextFor: async ({ requestId }: { requestId: string }) => runtimeContext(requestId, 'executor'),
    runtimeStoresFor: () => ({ state, config: null }),
    resolveProjectPathFor: async () => null,
    now: () => '2026-01-01T00:00:00.000Z',
    sleep: async () => undefined,
    toolsForWorkItemFor: async () => null,
    engineForContext: () => ({ finish: async () => { finishCalls += 1; } }),
  } as ExecutorApiDeps;
  const res = new FakeResponse();

  await handleExecutorResultFor(
    deps,
    jsonRequest({ job_id: 'job-1', executor_id: 'executor-old', claim_token: 'claim-old', ok: true, output: { text: 'stale' } }),
    res as unknown as ServerResponse,
  );

  assert.equal(res.statusCode, 200);
  assert.match(String(res.json()['note']), /过期回报/);
  assert.equal(finishCalls, 0);
});
