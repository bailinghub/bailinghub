import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import { handleAdminAgentClientsApiFor } from './admin-agent-clients';

class FakeResponse {
  statusCode = 0;
  body = Buffer.alloc(0);
  headers: Record<string, string | number | string[]> = {};
  setHeader(name: string, value: string | number | string[]): void { this.headers[name.toLowerCase()] = value; }
  writeHead(code: number, headers?: Record<string, string | number | string[]>): void {
    this.statusCode = code;
    Object.assign(this.headers, headers ?? {});
  }
  end(value?: string | Buffer): void { this.body = value ? Buffer.from(value) : Buffer.alloc(0); }
  json(): any { return JSON.parse(this.body.toString('utf8')); }
}

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

function fakeDeps() {
  let revoked = false;
  const audits: any[] = [];
  const session = {
    session_id: SESSION_ID,
    client_app_id: 'example-business',
    device_label: 'Development workstation',
    principal: { id: 'user-7', tenant: 'tenant-2', roles: ['manager'] },
    on_behalf_of: 'tenant-2:user-7',
    allowed_routes: ['orders'],
    created_at: '2026-08-27T00:00:00.000Z',
    access_expires_at: '2026-08-27T01:00:00.000Z',
    refresh_expires_at: '2026-09-27T00:00:00.000Z',
    last_seen_at: '2026-08-27T00:10:00.000Z',
    state: 'active' as const,
  };
  const configStore = {
    clients: {
      list: async () => [{
        app_id: 'example-business', name: 'Example business', token: 'PRIVATE_CLIENT_TOKEN', enabled: true,
        allowed_routes: ['orders'], allowed_channels: [], rate_limit_per_min: 60,
        agent_authorize_url: 'https://business.example.com/agent-authorize',
      }],
    },
    routes: {
      list: async () => [
        { route_key: 'orders', name: 'Order assistant', enabled: true, tools: {}, agent_client: { enabled: true } },
        { route_key: 'legacy', name: 'Legacy route', enabled: true, tools: {} },
      ],
    },
    agentAuth: {
      sessionSummaryForAdmin: async () => ({ total: 1, active: 1, expired: 0, revoked: 0 }),
      listSessionsForAdmin: async () => ({ list: [session], total: 1 }),
      getSessionForAdmin: async (id: string) => id === SESSION_ID ? session : null,
      revokeSessionForClient: async () => { revoked = true; return true; },
    },
    agentClientRuntime: {
      statsForAdmin: async () => [{
        client_app_id: 'example-business', runs: 3, conversations: 2, completed: 2, failed: 1,
        tool_calls: 5, total_tokens: 1200, approvals: { approved: 1 },
      }],
    },
  } as unknown as ConfigStoreContract;
  const stateStore = {
    appendAudit: async (entry: any) => { audits.push(entry); },
  } as unknown as RuntimeStateStore;
  return {
    deps: { configStore, stateStore, now: () => '2026-08-27T00:30:00.000Z' },
    audits,
    wasRevoked: () => revoked,
  };
}

test('智能体客户端 overview 聚合既有资源且不暴露接入方 token', async () => {
  const fx = fakeDeps();
  const res = new FakeResponse();
  const req = { url: '/admin/api/agent-clients/overview?days=7' } as IncomingMessage;
  const handled = await handleAdminAgentClientsApiFor(
    fx.deps,
    'GET',
    '/admin/api/agent-clients/overview',
    req,
    res as unknown as ServerResponse,
    { kind: 'admin', via: 'session', username: 'admin', role: 'admin' },
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const payload = res.json();
  assert.equal(payload.days, 7);
  assert.equal(payload.applications[0].stats.runs, 3);
  assert.deepEqual(payload.workspaces.map((item: any) => item.route), ['orders']);
  assert.equal(payload.summary.sessions.active, 1);
  assert.equal(payload.summary.failure_rate, 1 / 3);
  assert.equal(JSON.stringify(payload).includes('PRIVATE_CLIENT_TOKEN'), false);
  assert.equal(Object.hasOwn(payload.applications[0], 'token'), false);
});

test('管理员撤销 Agent Session 幂等调用受 Client 归属约束并写审计', async () => {
  const fx = fakeDeps();
  const res = new FakeResponse();
  await handleAdminAgentClientsApiFor(
    fx.deps,
    'POST',
    `/admin/api/agent-clients/sessions/${SESSION_ID}/revoke`,
    { url: `/admin/api/agent-clients/sessions/${SESSION_ID}/revoke` } as IncomingMessage,
    res as unknown as ServerResponse,
    { kind: 'admin', via: 'session', username: 'operator', role: 'admin' },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(fx.wasRevoked(), true);
  assert.equal(fx.audits.length, 1);
  assert.equal(fx.audits[0].event, 'agent_session_admin_revoked');
  assert.deepEqual(fx.audits[0].detail, {
    session_id: SESSION_ID,
    client_app_id: 'example-business',
    by: 'operator',
  });
});
