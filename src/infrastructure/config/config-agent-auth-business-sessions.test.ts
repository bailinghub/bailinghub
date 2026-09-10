import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { AgentAuthRepository } from './config-agent-auth-repository';
import { evaluateBusinessSessionQuery } from '../../test-support/agent-auth-business-query-fixture';

type Row = Record<string, any>;
const APP = 'example-business';
const OTHER_APP = 'other-business';
const sessionId = (n: number) => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
const authorizationId = (n: number) => `223e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
function session(n: number, overrides: Row = {}): Row {
  return {
    session_id: sessionId(n), client_app_id: APP, device_label: 'Synthetic device',
    principal_json: { id: 'user-7', tenant: 'tenant-2', roles: ['manager'], audience: 'internal', channel: 'browser', private_secret: 'DO_NOT_RETURN_PRINCIPAL_SECRET' },
    on_behalf_of: 'tenant-2:user-7', allowed_routes: ['orders'],
    access_token_hash: 'DO_NOT_RETURN_ACCESS_HASH', refresh_token: 'DO_NOT_RETURN_REFRESH_TOKEN',
    access_expires_at: '2000-01-01 00:00:00', refresh_expires_at: '2099-01-30 00:00:00',
    created_at: '2026-09-09 08:00:00', updated_at: '2026-09-09 08:00:00', last_seen_at: null, revoked_at: null,
    ...overrides,
  };
}

/** In-memory evaluator for the narrow generated SELECT surface, not a live DB. */
function queryFixture(seed: Row[], authorizations: Row[] = []) {
  const sessions = structuredClone(seed);
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = { async query(sql: string, params: unknown[] = []) {
    queries.push({ sql, params });
    return evaluateBusinessSessionQuery(sessions, authorizations, sql, params);
  } } as unknown as Pool;
  return { repo: new AgentAuthRepository(() => pool), sessions, queries };
}

test('business Session detail is App-scoped and returns a principal field whitelist without token material', async () => {
  const fx = queryFixture([session(1), session(2, { client_app_id: OTHER_APP })], [
    { authorization_id: authorizationId(1), session_id: sessionId(1), client_app_id: APP, status: 'consumed' },
  ]);
  const detail = (await fx.repo.getBusinessSession(APP, sessionId(1)))!;
  assert.equal(detail.authorization_id, authorizationId(1));
  assert.equal(detail.state, 'active', 'access expiry alone does not end the absolute refresh lifetime');
  assert.deepEqual(detail.principal, { id: 'user-7', tenant: 'tenant-2', roles: ['manager'], audience: 'internal', channel: 'browser' });
  assert.doesNotMatch(JSON.stringify(detail), /DO_NOT_RETURN|private_secret|token_hash|refresh_token|cursor_created_at/);
  assert.equal(await fx.repo.getBusinessSession(APP, sessionId(2)), null);
  assert.equal(await fx.repo.getBusinessSession(OTHER_APP, sessionId(1)), null);
  await assert.rejects(fx.repo.getBusinessSession('', sessionId(1)), /authenticated Client App/);
});

test('business Session selectors combine exact authorization, subject and principal/tenant filters with AND', async () => {
  const fx = queryFixture([
    session(1), session(2, { on_behalf_of: 'tenant-2:User-7' }),
    session(3, { principal_json: { id: 'User-7', tenant: 'tenant-2', roles: [] } }),
    session(4, { principal_json: { id: 'user-7', tenant: 'tenant-3', roles: [] } }),
    session(5, { client_app_id: OTHER_APP }),
  ], [1, 2, 3, 4, 5].map((n) => ({ authorization_id: authorizationId(n), session_id: sessionId(n), client_app_id: n === 5 ? OTHER_APP : APP, status: 'consumed' })));
  const input = { clientAppId: APP, authorizationId: authorizationId(1), onBehalfOf: 'tenant-2:user-7', principalId: 'user-7', tenant: 'tenant-2', state: 'active' as const, limit: 20 };
  assert.deepEqual((await fx.repo.listBusinessSessions(input)).list.map((row) => row.session_id), [sessionId(1)]);
  assert.deepEqual((await fx.repo.listBusinessSessions({ ...input, tenant: 'tenant-3' })).list, []);
  assert.deepEqual((await fx.repo.listBusinessSessions({ ...input, authorizationId: authorizationId(5) })).list, []);
  assert.deepEqual((await fx.repo.listBusinessSessions({ clientAppId: APP, onBehalfOf: 'tenant-2:User-7', limit: 20 })).list.map((row) => row.session_id), [sessionId(2)]);
  assert.match(fx.queries[0]!.sql, /matched\.client_app_id=s\.client_app_id/);
  assert.match(fx.queries[0]!.sql, /BINARY s\.on_behalf_of=BINARY \?/);
  assert.doesNotMatch(JSON.stringify((await fx.repo.listBusinessSessions({ clientAppId: APP, limit: 20 })).list), /DO_NOT_RETURN|private_secret/);
});

test('tenant absence is explicit and Session status distinguishes expiry, revocation and refreshable access', async () => {
  const fx = queryFixture([
    session(1, { principal_json: { id: 'user-7', roles: [] } }),
    session(2, { principal_json: { id: 'user-7', tenant: '', roles: [] } }),
    session(3, { principal_json: { id: 'user-7', tenant: null, roles: [] } }),
    session(4), session(5, { refresh_expires_at: '2000-01-01 00:00:00' }),
    session(6, { revoked_at: '2026-09-09 08:00:00' }),
  ]);
  assert.deepEqual((await fx.repo.listBusinessSessions({ clientAppId: APP, tenant: '', limit: 20 })).list.map((row) => row.session_id), [3, 2, 1].map(sessionId));
  assert.equal((await fx.repo.listBusinessSessions({ clientAppId: APP, limit: 20 })).list.length, 6);
  assert.deepEqual((await fx.repo.listBusinessSessions({ clientAppId: APP, state: 'expired', limit: 20 })).list.map((row) => row.state), ['expired']);
  assert.deepEqual((await fx.repo.listBusinessSessions({ clientAppId: APP, state: 'revoked', limit: 20 })).list.map((row) => row.state), ['revoked']);
  assert.equal((await fx.repo.listBusinessSessions({ clientAppId: APP, state: 'active', limit: 20 })).list.length, 4);
});

test('keyset pages preserve identical timestamps and remain stable when earlier active Sessions are revoked', async () => {
  const fx = queryFixture([session(1), session(2), session(3), session(4)]);
  const input = { clientAppId: APP, state: 'active' as const, limit: 2 };
  const first = await fx.repo.listBusinessSessions(input);
  assert.deepEqual(first.list.map((row) => row.session_id), [4, 3].map(sessionId));
  assert.deepEqual(first.nextCursor, { createdAt: '2026-09-09T08:00:00.000Z', sessionId: sessionId(3) });
  for (const row of fx.sessions.filter((item) => [sessionId(3), sessionId(4)].includes(item.session_id))) row.revoked_at = '2026-09-09 09:00:00';
  const second = await fx.repo.listBusinessSessions({ ...input, cursor: first.nextCursor });
  assert.deepEqual(second.list.map((row) => row.session_id), [2, 1].map(sessionId));
  assert.equal(second.nextCursor, undefined);
  assert.equal(fx.queries[0]!.params.at(-1), 3, 'the repository fetches limit+1');
  await fx.repo.listBusinessSessions({ clientAppId: APP, limit: 999 });
  assert.equal(fx.queries.at(-1)!.params.at(-1), 101);
});

test('duplicate or cross-App authorization links do not duplicate Session rows or invent an unambiguous mapping', async () => {
  const fx = queryFixture([session(1), session(2)], [
    { authorization_id: authorizationId(1), session_id: sessionId(1), client_app_id: APP, status: 'consumed' },
    { authorization_id: authorizationId(2), session_id: sessionId(1), client_app_id: APP, status: 'consumed' },
    { authorization_id: authorizationId(3), session_id: sessionId(2), client_app_id: OTHER_APP, status: 'consumed' },
  ]);
  const page = await fx.repo.listBusinessSessions({ clientAppId: APP, limit: 20 });
  assert.equal(page.list.length, 2);
  assert.ok(page.list.every((row) => !Object.hasOwn(row, 'authorization_id')));
  assert.equal((await fx.repo.listBusinessSessions({ clientAppId: APP, authorizationId: authorizationId(1), limit: 20 })).list.length, 1);
  assert.equal((await fx.repo.listBusinessSessions({ clientAppId: APP, authorizationId: authorizationId(3), limit: 20 })).list.length, 0);
  assert.match(fx.queries[0]!.sql, /CASE WHEN COUNT\(\*\)=1 THEN MIN\(a\.authorization_id\) ELSE NULL END/);
});

test('authorization projections include consumed Session mapping while code/token hashes remain internal', async () => {
  const row = {
    authorization_id: authorizationId(1), client_app_id: APP, redirect_uri: 'http://127.0.0.1:43123/callback', state_value: 'synthetic-state',
    requested_routes: ['orders'], device_label: 'Synthetic device', code_challenge: 'c'.repeat(43),
    status: 'consumed', session_id: sessionId(1), created_at: '2026-09-09 08:00:00', expires_at: '2026-09-09 08:10:00', code_hash: 'DO_NOT_RETURN_CODE_HASH',
  };
  const pool = { query: async () => [[row], []] } as unknown as Pool;
  const result = await new AgentAuthRepository(() => pool).getAuthorization(authorizationId(1));
  assert.equal(result?.session_id, sessionId(1));
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_RETURN|code_hash/);
});
