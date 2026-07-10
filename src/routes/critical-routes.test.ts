import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '../app/auth';
import type { AppConfig } from '../core/config/config';
import type { RuntimeContext } from '../core/edition';
import type { Client, Job, Route, ToolApproval } from '../core/contracts/types';
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
