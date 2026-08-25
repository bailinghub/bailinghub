import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { AgentSession, Client, Job } from '../core/contracts/types';
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
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
  req.method = method;
  req.headers = headers;
  return req;
}

test('Agent API job reads are isolated to the originating Agent Session', async () => {
  const token = `bha_${'a'.repeat(43)}`;
  const client: Client = {
    app_id: 'digital-cloud', name: 'Digital Cloud', token: 'client-token',
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
    profile: 'general', project: '', source: 'agent:digital-cloud', client_app_id: client.app_id,
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
    app_id: 'digital-cloud', name: 'Digital Cloud', token: 'client-token',
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
    app_id: 'digital-cloud', name: 'Digital Cloud', token: 'client-token',
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
