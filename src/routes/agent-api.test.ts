import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { AgentSession, Client, Job } from '../core/contracts/types';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import { tokenHash } from './agent-auth';
import { handleAgentApiHttpFor } from './agent-api';

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

function request(method: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
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
