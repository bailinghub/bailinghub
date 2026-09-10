import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import type { Pool } from 'mysql2/promise';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { AgentAuthRepository } from '../infrastructure/config/config-agent-auth-repository';
import { evaluateBusinessSessionQuery } from '../test-support/agent-auth-business-query-fixture';
import { LedgerFixture, REDIRECT } from '../test-support/agent-auth-lifecycle-fixture';
import { handleAgentAuthHttpFor, pkceChallenge } from './agent-auth';

// Real loopback HTTP, route parsing/authorization and repository SQL. Only the
// SQL engine, client registry and rate counter are synthetic; no MySQL or business
// server is contacted. Transaction/lock semantics have separate repository tests.
const CLIENTS = [
  { app_id: 'example-business', name: 'Example', enabled: true, token: 'synthetic-client-token-a', allowed_routes: ['orders'], agent_authorize_url: 'https://example.test/authorize' },
  { app_id: 'other-business', name: 'Other', enabled: true, token: 'synthetic-client-token-b', allowed_routes: ['inventory'], agent_authorize_url: 'https://other.example.test/authorize' },
] as const;
type SyntheticClient = typeof CLIENTS[number];
const A = CLIENTS[0];
const B = CLIENTS[1];
const verifier = 'synthetic-pkce-verifier-'.padEnd(64, 'v');
const principal = { id: 'operator', tenant: 'tenant-A', roles: ['manager'] };

/** Match the production mysql2 pool's timezone:'Z' DATETIME result decoding. */
function driverRows(result: any[]): any[] {
  if (!Array.isArray(result[0])) return result;
  return [result[0].map((row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    key.endsWith('_at') && typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
      ? new Date(`${value.replace(' ', 'T')}Z`) : value,
  ]))), ...result.slice(1)];
}

async function fixture(t: TestContext) {
  const ledger = new LedgerFixture();
  for (const table of Object.values(ledger.rows)) table.clear();
  const originalQuery = ledger.pool.query.bind(ledger.pool) as (sql: string, params: unknown[]) => Promise<any[]>;
  const pool = {
    async getConnection() {
      const connection = await ledger.pool.getConnection();
      return {
        beginTransaction: connection.beginTransaction.bind(connection), commit: connection.commit.bind(connection),
        rollback: connection.rollback.bind(connection), release: connection.release.bind(connection),
        async query(sql: string, params: unknown[] = []) { return driverRows(await connection.query(sql, params)); },
      };
    },
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('FROM bz_agent_sessions s WHERE')) {
        return driverRows(evaluateBusinessSessionQuery([...ledger.rows.session.values()], [...ledger.rows.authorization.values()], sql, params));
      }
      return driverRows(await originalQuery(sql, params));
    },
  } as unknown as Pool;
  const repository = new AgentAuthRepository(() => pool);
  const store = {
    agentAuth: repository,
    clients: {
      async get(id: string) { return CLIENTS.find((client) => client.app_id === id) ?? null; },
      async getByToken(token: string) { return CLIENTS.find((client) => client.token === token) ?? null; },
    },
    rateLimits: { async consume() { return false; } },
  } as unknown as ConfigStoreContract;
  const failures: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      if (!await handleAgentAuthHttpFor({ configStore: store }, req, res, new URL(req.url!, 'http://127.0.0.1'))) {
        res.writeHead(404); res.end();
      }
    } catch (error) { failures.push(error); res.writeHead(500); res.end('{"error":"fixture_failure"}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.deepEqual(failures, [], 'unexpected SQL or route exceptions must fail the integration');
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(path: string, method = 'GET', body?: unknown, token?: string) {
    const response = await fetch(`${origin}/agent-auth/v1${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (path === '/token') assert.equal(response.headers.get('pragma'), 'no-cache');
    return { status: response.status, body: await response.json() as any };
  }
  async function approve(client: SyntheticClient = A) {
    const created = await call('/authorizations', 'POST', {
      client_app_id: client.app_id, redirect_uri: REDIRECT, state: 'synthetic-state', requested_routes: client.allowed_routes,
      device_label: 'Synthetic device', code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
    });
    assert.equal(created.status, 201);
    const id: string = created.body.authorization_id;
    assert.equal(new URL(created.body.authorization_url).searchParams.get('authorization_id'), id);
    const context = await call(`/authorizations/${id}`, 'GET', undefined, client.token);
    assert.equal(context.status, 200); assert.equal(context.body.status, 'pending');
    const approved = await call(`/authorizations/${id}/approve`, 'POST', { principal, on_behalf_of: 'tenant-A:operator', allowed_routes: client.allowed_routes }, client.token);
    assert.equal(approved.status, 200);
    const redirect = new URL(approved.body.redirect_uri);
    assert.equal(redirect.searchParams.get('state'), 'synthetic-state');
    const code = redirect.searchParams.get('code'); assert.ok(code);
    return { id, client, code };
  }
  async function exchange(authorization: Awaited<ReturnType<typeof approve>>) {
    return call('/token', 'POST', { grant_type: 'authorization_code', client_app_id: authorization.client.app_id,
      code: authorization.code, redirect_uri: REDIRECT, code_verifier: verifier });
  }
  return { ledger, call, approve, exchange };
}

test('HTTP and real repository: approved authorization links to a scoped session; atomic revoke rejects access and refresh', async (t) => {
  const f = await fixture(t);
  const authorization = await f.approve();
  const token = await f.exchange(authorization); assert.equal(token.status, 200);
  const sessionId = token.body.session_id;
  assert.equal(f.ledger.rows.authorization.get(authorization.id)?.session_id, sessionId);
  const context = await f.call(`/authorizations/${authorization.id}`, 'GET', undefined, A.token);
  assert.equal(context.status, 200); assert.equal(context.body.status, 'consumed');
  assert.deepEqual(Object.keys(context.body.session).sort(), ['expires_at', 'session_id', 'state', 'subject_display', 'subject_display_status']);
  assert.equal(context.body.session.session_id, sessionId); assert.equal(context.body.session.state, 'active');
  assert.doesNotMatch(JSON.stringify(context.body), /code_hash|code_challenge|redirect_uri|access_token|refresh_token|principal/);

  const filters = new URLSearchParams({ authorization_id: authorization.id, on_behalf_of: 'tenant-A:operator', principal_id: 'operator', tenant: 'tenant-A', state: 'active' });
  const listed = await f.call(`/sessions?${filters}`, 'GET', undefined, A.token);
  assert.equal(listed.status, 200); assert.equal(listed.body.list.length, 1);
  assert.equal(listed.body.list[0].session_id, sessionId); assert.equal(listed.body.list[0].authorization_id, authorization.id);
  assert.deepEqual(listed.body.list[0].principal, principal); assert.equal(listed.body.next_cursor, null);
  assert.doesNotMatch(JSON.stringify(listed.body), /token_hash|access_token|refresh_token|code_challenge|code_hash/);
  filters.set('tenant', 'tenant-B');
  assert.deepEqual((await f.call(`/sessions?${filters}`, 'GET', undefined, A.token)).body.list, []);
  assert.equal((await f.call('/session', 'GET', undefined, token.body.access_token)).status, 200);

  const revoked = await f.call(`/authorizations/${authorization.id}/revoke`, 'POST', {}, A.token);
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body, { authorization_id: authorization.id, revoked: true, session_id: sessionId });
  const after = await f.call(`/authorizations/${authorization.id}`, 'GET', undefined, A.token);
  assert.equal(after.body.status, 'consumed'); assert.equal(after.body.session.state, 'revoked'); assert.ok(after.body.session.revoked_at);
  assert.equal((await f.call('/session', 'GET', undefined, token.body.access_token)).status, 401);
  const refreshed = await f.call('/token', 'POST', { grant_type: 'refresh_token', client_app_id: A.app_id, refresh_token: token.body.refresh_token });
  assert.deepEqual(refreshed, { status: 400, body: { error: 'invalid_grant' } });
  assert.deepEqual(await f.call(`/authorizations/${authorization.id}/revoke`, 'POST', {}, A.token), revoked);
  assert.equal(f.ledger.rows.session.size, 1); assert.equal(f.ledger.rows.token.size, 1);
  assert.ok(f.ledger.rows.session.get(sessionId)?.revoked_at);
  assert.ok([...f.ledger.rows.token.values()].every((row) => row.status === 'revoked'));
});

test('HTTP and real repository: revocation after approval but before exchange prevents session issuance', async (t) => {
  const f = await fixture(t); const authorization = await f.approve();
  const revoked = await f.call(`/authorizations/${authorization.id}/revoke`, 'POST', {}, A.token);
  assert.deepEqual(revoked, { status: 200, body: { authorization_id: authorization.id, revoked: true } });
  const stored = f.ledger.rows.authorization.get(authorization.id)!;
  assert.equal(stored.status, 'revoked'); assert.equal(stored.code_hash, null); assert.equal(stored.code_expires_at, null);
  assert.deepEqual(await f.exchange(authorization), { status: 400, body: { error: 'invalid_grant' } });
  assert.equal(f.ledger.rows.session.size, 0); assert.equal(f.ledger.rows.token.size, 0);
  const context = await f.call(`/authorizations/${authorization.id}`, 'GET', undefined, A.token);
  assert.equal(context.body.status, 'revoked'); assert.equal('session' in context.body, false);
  assert.deepEqual(await f.call(`/authorizations/${authorization.id}/revoke`, 'POST', {}, A.token), revoked);
});

test('HTTP and real repository: another Client App cannot query or revoke an authorization or its session', async (t) => {
  const f = await fixture(t);
  const authorizationA = await f.approve(A); const tokenA = await f.exchange(authorizationA); assert.equal(tokenA.status, 200);
  const authorizationB = await f.approve(B); const tokenB = await f.exchange(authorizationB); assert.equal(tokenB.status, 200);
  const unknown = { status: 404, body: { error: 'not_found' } };
  assert.deepEqual(await f.call(`/authorizations/${authorizationA.id}`, 'GET', undefined, B.token), unknown);
  assert.deepEqual(await f.call(`/authorizations/${authorizationA.id}/revoke`, 'POST', {}, B.token), unknown);
  assert.deepEqual(await f.call(`/sessions/${tokenA.body.session_id}/revoke`, 'POST', {}, B.token), unknown);
  const hidden = await f.call(`/sessions?authorization_id=${authorizationA.id}`, 'GET', undefined, B.token);
  assert.deepEqual(hidden, { status: 200, body: { list: [], next_cursor: null } });
  for (const [client, token] of [[A, tokenA], [B, tokenB]] as const) {
    const list = await f.call('/sessions?tenant=tenant-A', 'GET', undefined, client.token);
    assert.equal(list.status, 200); assert.equal(list.body.list.length, 1);
    assert.equal(list.body.list[0].client_app_id, client.app_id); assert.equal(list.body.list[0].session_id, token.body.session_id);
    assert.equal((await f.call('/session', 'GET', undefined, token.body.access_token)).status, 200);
  }
  assert.ok([...f.ledger.rows.session.values()].every((row) => row.revoked_at === null));
  assert.ok([...f.ledger.rows.token.values()].every((row) => row.status === 'active'));
});
