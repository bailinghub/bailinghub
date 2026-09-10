import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { AgentAuthRepository } from '../infrastructure/config/config-agent-auth-repository';
import { APP, AUTH, SESSION, LedgerFixture, REDIRECT } from '../test-support/agent-auth-lifecycle-fixture';
import { handleAgentAuthHttpFor, pkceChallenge } from './agent-auth';

async function fixture(t: test.TestContext) {
  const ledger = new LedgerFixture();
  // Match production mysql2 timezone:'Z' decoding instead of interpreting SQL
  // DATETIME strings in the developer machine's local timezone.
  function driverRows(result: any[]): any[] {
    if (!Array.isArray(result[0])) return result;
    return [result[0].map((row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      key.endsWith('_at') && typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
        ? new Date(`${value.replace(' ', 'T')}Z`) : value,
    ]))), ...result.slice(1)];
  }
  const pool = {
    async getConnection() {
      const connection = await ledger.pool.getConnection();
      return {
        beginTransaction: connection.beginTransaction.bind(connection), commit: connection.commit.bind(connection),
        rollback: connection.rollback.bind(connection), release: connection.release.bind(connection),
        async query(sql: string, params: unknown[] = []) { return driverRows(await connection.query(sql, params)); },
      };
    },
    async query(sql: string, params: unknown[] = []) { return driverRows(await ledger.pool.query(sql, params)); },
  } as unknown as Pool;
  const repository = new AgentAuthRepository(() => pool);
  const verifier = 'v'.repeat(43);
  ledger.rows.authorization.get(AUTH)!.code_challenge = pkceChallenge(verifier);
  const client = { app_id: APP, name: 'Example Service', token: 'synthetic-business', enabled: true,
    agent_authorize_url: 'https://business.example.com/authorize', allowed_routes: ['shop'] };
  const other = { ...client, app_id: 'other-service', token: 'synthetic-other' };
  const store = { agentAuth: repository, clients: {
    getByToken: async (token: string) => token === client.token ? client : token === other.token ? other : null,
    get: async (id: string) => id === client.app_id ? client : id === other.app_id ? other : null,
  } } as unknown as ConfigStoreContract;
  const server = createServer((req, res) => {
    void handleAgentAuthHttpFor({ configStore: store }, req, res, new URL(req.url!, 'http://127.0.0.1'))
      .catch(() => { res.statusCode = 500; res.end('{"error":"synthetic_test_error"}'); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  async function call(method: string, path: string, body?: unknown, bearer?: string) {
    const response = await fetch(`${origin}${path}`, { method,
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
  }
  const approval = { principal: { id: 'operator-a', tenant: 'account-a', roles: ['manager'] },
    on_behalf_of: 'account-a:operator-a', allowed_routes: ['shop'] };
  async function authorize(display?: unknown) {
    const result = await call('POST', `/agent-auth/v1/authorizations/${AUTH}/approve`, {
      ...approval, ...(display === undefined ? {} : { subject_display: display }),
    }, client.token);
    assert.equal(result.status, 200);
    const redirect = new URL(result.body.redirect_uri);
    assert.deepEqual([...redirect.searchParams.keys()].sort(), ['code', 'state']);
    const token = await call('POST', '/agent-auth/v1/token', { grant_type: 'authorization_code', client_app_id: APP,
      code: redirect.searchParams.get('code'), redirect_uri: REDIRECT, code_verifier: verifier });
    assert.equal(token.status, 200);
    return token.body;
  }
  return { ledger, store, call, authorize, approval, client, other };
}

test('HTTP approve -> exchange -> session -> in-place rename -> refresh carries only subject display', async (t) => {
  const f = await fixture(t); const token = await f.authorize({ name: '  Workspace North  ' });
  assert.deepEqual(token.subject_display, { name: 'Workspace North' });
  assert.equal(token.subject_display_status, 'provided');
  const path = `/agent-auth/v1/sessions/${token.session_id}/subject-display`;
  const before = await f.call('GET', '/agent-auth/v1/session', undefined, token.access_token);
  assert.equal(before.status, 200); assert.equal(before.headers.get('cache-control'), 'no-store');
  const renamed = await f.call('PUT', path, { subject_display: { name: 'Workspace East' } }, f.client.token);
  assert.equal(renamed.status, 200); assert.equal(renamed.body.state, 'active');
  assert.equal(renamed.body.authorization_id, AUTH);
  for (const forbidden of ['access_token', 'refresh_token', 'access_token_hash', 'refresh_token_hash', 'token_hash', 'code']) {
    assert.equal(forbidden in renamed.body, false);
  }
  const after = await f.call('GET', '/agent-auth/v1/session', undefined, token.access_token);
  assert.deepEqual(after.body, { ...before.body, subject_display: { name: 'Workspace East' } });
  const consumed = await f.call('GET', `/agent-auth/v1/authorizations/${AUTH}`, undefined, f.client.token);
  assert.deepEqual(consumed.body.session.subject_display, { name: 'Workspace East' });
  const refreshed = await f.call('POST', '/agent-auth/v1/token', { grant_type: 'refresh_token', client_app_id: APP, refresh_token: token.refresh_token });
  assert.equal(refreshed.status, 200); assert.equal(refreshed.body.session_id, token.session_id);
  assert.deepEqual(refreshed.body.subject_display, { name: 'Workspace East' });
  assert.equal(f.ledger.rows.session.size, 1);
  const clear = await f.call('PUT', path, { subject_display: null }, f.client.token);
  assert.equal(clear.status, 200); assert.equal(clear.body.subject_display_status, 'missing');
  assert.equal(clear.body.subject_display, null);
});

test('HTTP old unnamed authorization can be backfilled on the original Session', async (t) => {
  const f = await fixture(t); const token = await f.authorize();
  assert.equal(token.subject_display, null); assert.equal(token.subject_display_status, 'missing');
  const before = await f.call('GET', '/agent-auth/v1/session', undefined, token.access_token);
  const result = await f.call('PUT', `/agent-auth/v1/sessions/${token.session_id}/subject-display`, { subject_display: { name: 'Company A' } }, f.client.token);
  assert.equal(result.status, 200);
  const after = await f.call('GET', '/agent-auth/v1/session', undefined, token.access_token);
  assert.deepEqual(after.body, { ...before.body, subject_display: { name: 'Company A' }, subject_display_status: 'provided' });
  assert.equal(f.ledger.rows.session.size, 1); assert.equal(f.ledger.rows.token.size, 1);
});

test('HTTP display metadata rejects foreign clients, Agent bearers and identity mutations', async (t) => {
  const f = await fixture(t); const token = await f.authorize({ name: 'Account A' });
  const path = `/agent-auth/v1/sessions/${token.session_id}/subject-display`;
  const body = { subject_display: { name: 'Other' } };
  assert.equal((await f.call('PUT', path, body)).status, 401);
  assert.equal((await f.call('PUT', path, body, token.access_token)).status, 401);
  assert.equal((await f.call('PUT', path + '?token=' + f.client.token, body)).status, 401);
  assert.equal((await f.call('PUT', path, body, f.other.token)).status, 404);
  assert.equal((await f.call('POST', path, body, f.client.token)).status, 405);
  assert.equal((await f.call('PUT', `/agent-auth/v1/sessions/${SESSION}/subject-display`, body, f.client.token)).status, 404);
  for (const invalid of [{}, { ...body, principal: { id: 'other' } }, { ...body, allowed_routes: ['other'] },
    { subject_display: { name: 'A', token: 'synthetic' } }, { subject_display: { name: '\nAccount' } },
    { subject_display: { name: 'A\u0085B' } }, { subject_display: { name: 'A\u2028B' } }, { subject_display: { name: '\ud800' } },
    { subject_display: { name: '\udc00' } }, { subject_display: { name: '😀'.repeat(61) } }]) {
    assert.equal((await f.call('PUT', path, invalid, f.client.token)).status, 400);
  }
  await f.ledger.repository.revokeSessionForClient(APP, token.session_id);
  const revoked = await f.call('PUT', path, body, f.client.token);
  assert.equal(revoked.status, 409); assert.equal(revoked.body.error, 'session_inactive');
  assert.equal((await f.call('GET', '/agent-auth/v1/session', undefined, token.access_token)).status, 401);
});

test('HTTP approve validates optional display before writes; old Host explicitly rejects named approvals', async (t) => {
  const f = await fixture(t); const path = `/agent-auth/v1/authorizations/${AUTH}/approve`;
  for (const display of [{ name: '' }, { name: '\tA' }, { name: 'A'.repeat(121) }, { name: 'A', id: 'foreign' }, { name: ['A'] }]) {
    assert.equal((await f.call('POST', path, { ...f.approval, subject_display: display }, f.client.token)).status, 400);
  }
  assert.equal(f.ledger.rows.authorization.get(AUTH)!.status, 'pending');
  Object.defineProperty(f.store.agentAuth!, 'updateSubjectDisplay', { value: undefined });
  const unsupported = await f.call('POST', path, { ...f.approval, subject_display: { name: 'A' } }, f.client.token);
  assert.equal(unsupported.status, 503); assert.equal(unsupported.body.error, 'subject_display_unavailable');
  assert.equal(f.ledger.rows.authorization.get(AUTH)!.status, 'pending');
  const old = await f.authorize(); assert.equal(old.subject_display_status, 'missing');
  const update = await f.call('PUT', `/agent-auth/v1/sessions/${old.session_id}/subject-display`, { subject_display: { name: 'A' } }, f.client.token);
  assert.equal(update.status, 503); assert.equal(update.body.error, 'subject_display_unavailable');
});
