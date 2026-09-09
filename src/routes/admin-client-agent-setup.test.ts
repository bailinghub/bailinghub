import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '../app/auth';
import { handleAdminAccessApiFor } from './admin-access';
import { ClientRepository } from '../infrastructure/config/config-client-repository';
import { clientAgentSetupRevision } from '../core/config/client-agent-setup';
import { rowClient } from '../core/config/config-codec';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';

class Response {
  statusCode = 0; body = '';
  writeHead(value: number) { this.statusCode = value; }
  setHeader() {}
  end(value = '') { this.body = String(value); }
  json() { return JSON.parse(this.body); }
}
const admin: Principal = { kind: 'admin', via: 'session', username: 'maintainer', role: 'admin' };
function fixture() {
  const row: Record<string, any> = { app_id: 'helpdesk', name: 'Helpdesk', enabled: 1, token: 'synthetic-preserved-token', agent_authorize_url: 'https://example.test/authorize',
    allowed_routes: '["helpdesk"]', allowed_channels: '["alerts"]', rate_limit_per_min: 37, budget: '{"hard_tokens":1200}', description: 'private administrator note' };
  const sql: string[] = []; let rollbacks = 0; let commits = 0; let released = 0;
  const connection = {
    beginTransaction: async () => {}, rollback: async () => { rollbacks++; }, commit: async () => { commits++; }, release: () => { released++; },
    query: async (query: string, params: any[]) => {
      sql.push(query);
      if (query.startsWith('SELECT')) return [[{ ...row }]];
      assert.match(query, /^UPDATE bz_clients SET enabled=\?,agent_authorize_url=\?,allowed_routes=\?,updated_at=\? WHERE app_id=\?$/);
      Object.assign(row, { enabled: params[0], agent_authorize_url: params[1], allowed_routes: params[2], updated_at: params[3] });
      return [{ affectedRows: 1 }];
    },
  };
  const pool = { getConnection: async () => connection, query: async () => [[{ ...row }]] };
  const clients = new ClientRepository(() => pool);
  const deps = { configStore: { clients } as unknown as ConfigStoreContract, stateStore: {} as RuntimeStateStore, now: () => '2026-01-01T00:00:00Z' };
  const body = () => ({ expected_revision: clientAgentSetupRevision(rowClient(row)), enabled: false, agent_authorize_url: 'https://example.test/new-authorize', allowed_routes: ['helpdesk', 'inventory'] });
  async function call(method = 'GET', value?: unknown, principal = admin) {
    const req = Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]) as unknown as IncomingMessage;
    req.headers = {}; const res = new Response();
    await handleAdminAccessApiFor(deps, method, '/admin/api/clients/helpdesk/agent-setup', req, res as unknown as ServerResponse, principal);
    return res;
  }
  return { row, sql, clients, body, call, counts: () => ({ rollbacks, commits, released }) };
}

test('client setup GET and PUT never expose credentials; narrow SQL preserves unrelated configuration', async () => {
  const f = fixture(); const before = structuredClone(f.row);
  const read = await f.call(); assert.equal(read.statusCode, 200);
  assert.deepEqual(Object.keys(read.json()).sort(), ['agent_authorize_url', 'allowed_routes', 'app_id', 'enabled', 'name', 'revision']);
  const saved = await f.call('PUT', f.body()); assert.equal(saved.statusCode, 200, saved.body);
  for (const output of [read.body, saved.body]) assert.doesNotMatch(output, /synthetic-preserved-token|private administrator note|hard_tokens/);
  for (const key of ['token', 'allowed_channels', 'rate_limit_per_min', 'budget', 'description', 'name']) assert.equal(f.row[key], before[key]);
  assert.equal(f.row.enabled, 0); assert.deepEqual(JSON.parse(f.row.allowed_routes), ['helpdesk', 'inventory']);
  assert.notEqual(saved.json().revision, read.json().revision);
  assert.deepEqual(f.counts(), { rollbacks: 0, commits: 1, released: 1 });
});

test('stale client setup rejects under the row lock and does not overwrite concurrent settings', async () => {
  const f = fixture(); const body = f.body(); f.row.agent_authorize_url = 'https://example.test/concurrent';
  const res = await f.call('PUT', body); assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'agent_setup_conflict'); assert.equal(f.row.enabled, 1);
  assert.equal(f.sql.filter((s) => s.startsWith('UPDATE')).length, 0);
  assert.deepEqual(f.counts(), { rollbacks: 1, commits: 0, released: 1 });
});

test('client setup rejects missing write permission and forbids token rotation or extra fields', async () => {
  const f = fixture();
  const viewer = { ...admin, permissions: ['clients:read'] } as Principal;
  assert.equal((await f.call('GET', undefined, viewer)).statusCode, 200);
  assert.equal((await f.call('PUT', f.body(), viewer)).statusCode, 403);
  for (const extra of [{ rotate_token: true }, { token: 'anything' }, { app_id: 'other-client' }, { allowed_channels: ['*'] }]) {
    assert.equal((await f.call('PUT', { ...f.body(), ...extra })).statusCode, 400);
  }
  assert.equal(f.counts().commits, 0);
});

test('client setup validates authorization URL and allowed routes without fallback to all routes', async () => {
  const f = fixture();
  for (const bad of [{ agent_authorize_url: 'http://example.test/auth' }, { agent_authorize_url: 'https://user:pass@example.test/auth' }, { allowed_routes: [] }, { allowed_routes: [null] }, { allowed_routes: ['bad/route'] }]) {
    assert.equal((await f.call('PUT', { ...f.body(), ...bad })).statusCode, 400);
  }
  assert.equal(f.counts().commits, 0);
  assert.equal((await f.call('PUT', { ...f.body(), agent_authorize_url: null })).statusCode, 200);
  assert.equal(f.row.agent_authorize_url, null);
});

test('old Host without the optional client update method returns explicit unsupported', async () => {
  const f = fixture(); (f.clients as any).updateAgentSetup = undefined;
  const res = await f.call('PUT', f.body()); assert.equal(res.statusCode, 503); assert.equal(res.json().error, 'agent_setup_unsupported');
  assert.equal((await f.call()).statusCode, 200); assert.equal(f.counts().commits, 0);
});
