import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { handleAgentAuthHttpFor } from './agent-auth';

const authorizationId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const createdAt = '2026-09-09T01:00:00.000Z';
const expiry = '2026-10-09T01:00:00.000Z';

class Response {
  statusCode = 0;
  headers: Record<string, unknown> = {};
  body = '';
  setHeader(key: string, value: unknown): void { this.headers[key.toLowerCase()] = value; }
  writeHead(code: number, headers: Record<string, unknown> = {}): void { this.statusCode = code; Object.assign(this.headers, headers); }
  end(value: string): void { this.body = value; }
  json(): any { return JSON.parse(this.body); }
}

function fixture() {
  const client = { app_id: 'example-business', name: 'Business', enabled: true, token: 'fixture-business-token' };
  const other = { app_id: 'other-business', name: 'Other', enabled: true, token: 'fixture-other-token' };
  const session: any = {
    session_id: sessionId, authorization_id: authorizationId, client_app_id: client.app_id,
    device_label: 'Example device', principal: { id: 'operator', tenant: 'tenant-A', roles: ['admin'], private_key: 'nested-secret' },
    on_behalf_of: 'tenant-A:operator', allowed_routes: ['orders'], state: 'active',
    created_at: createdAt, access_expires_at: createdAt, refresh_expires_at: expiry,
    access_token: 'access-secret', refresh_token: 'refresh-secret', access_token_hash: 'hash-secret', refresh_token_hash: 'hash-secret-2',
  };
  const authorization: any = {
    authorization_id: authorizationId, client_app_id: client.app_id, status: 'consumed', session_id: sessionId,
    device_label: 'Example device', requested_routes: ['orders'], expires_at: createdAt,
    redirect_uri: 'http://127.0.0.1:12345/callback', code_hash: 'code-secret', state: 'state-secret', code_challenge: 'challenge-secret',
  };
  const calls: any[] = [];
  const repository: any = {
    async getAuthorization(id: string) { return id === authorizationId ? authorization : null; },
    async getBusinessSession(app: string, id: string) { calls.push(['get', app, id]); return app === client.app_id && id === sessionId ? session : null; },
    async listBusinessSessions(input: any) { calls.push(['list', input]); return { list: input.clientAppId === client.app_id ? [session] : [], nextCursor: undefined }; },
    async revokeAuthorization(input: any) {
      calls.push(['revoke', input]);
      return input.clientAppId === client.app_id && input.authorizationId === authorizationId
        ? { ok: true, authorization, sessionId } : { ok: false, reason: 'wrong_client' };
    },
  };
  const store: any = {
    agentAuth: repository,
    clients: { async getByToken(token: string) { return token === client.token ? client : token === other.token ? other : null; } },
  };
  async function call(path: string, method = 'GET', body?: unknown, token: string | null = client.token) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
    req.method = method;
    req.headers = token ? { authorization: `Bearer ${token}` } : {};
    const res = new Response();
    assert.equal(await handleAgentAuthHttpFor({ configStore: store as ConfigStoreContract }, req, res as unknown as ServerResponse, new URL(path, 'https://hub.example.com')), true);
    assert.equal(res.headers['cache-control'], 'no-store');
    return res;
  }
  return { client, other, session, authorization, calls, repository, store, call };
}

test('business session list uses Client bearer only and projects nested metadata without credentials', async () => {
  const f = fixture();
  for (const token of [null, 'bha_' + 'x'.repeat(43), 'admin-token', 'unknown']) {
    assert.equal((await f.call('/agent-auth/v1/sessions', 'GET', undefined, token)).statusCode, 401);
  }
  assert.equal((await f.call('/agent-auth/v1/sessions?token=fixture-business-token', 'GET', undefined, null)).statusCode, 401);
  assert.equal(f.calls.length, 0);
  const result = await f.call('/agent-auth/v1/sessions');
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().next_cursor, null);
  assert.deepEqual(result.json().list[0], {
    session_id: sessionId, authorization_id: authorizationId, client_app_id: f.client.app_id,
    device_label: 'Example device', principal: { id: 'operator', tenant: 'tenant-A', roles: ['admin'] },
    on_behalf_of: 'tenant-A:operator', allowed_routes: ['orders'], state: 'active', created_at: createdAt, expires_at: expiry,
    subject_display: null, subject_display_status: 'missing',
  });
  assert.doesNotMatch(result.body, /secret|token_hash|refresh_token|access_token/);
  assert.equal((await f.call('/agent-auth/v1/sessions', 'GET', undefined, f.other.token)).json().list.length, 0);
  f.client.enabled = false;
  assert.equal((await f.call('/agent-auth/v1/sessions')).statusCode, 401);
});

test('business list filters are exact AND inputs, including a tenant-only scope and explicit no-tenant principal', async () => {
  const f = fixture();
  const query = new URLSearchParams({ authorization_id: authorizationId, on_behalf_of: 'tenant-A:operator', principal_id: 'operator', tenant: 'tenant-A', state: 'revoked', limit: '7' });
  assert.equal((await f.call(`/agent-auth/v1/sessions?${query}`)).statusCode, 200);
  assert.deepEqual(f.calls[0][1], {
    clientAppId: 'example-business', authorizationId, onBehalfOf: 'tenant-A:operator', principalId: 'operator', tenant: 'tenant-A', state: 'revoked', limit: 7, cursor: undefined,
  });
  assert.equal((await f.call('/agent-auth/v1/sessions?tenant=tenant-A')).statusCode, 200);
  assert.equal(f.calls[1][1].tenant, 'tenant-A');
  assert.equal((await f.call('/agent-auth/v1/sessions?principal_id=operator&tenant=')).statusCode, 200);
  assert.equal(f.calls[2][1].tenant, '');
});

test('business session list rejects duplicate, unknown, overbroad and malformed filters before repository access', async () => {
  const f = fixture();
  const queries = [
    'client_app_id=other-business', 'token=secret', 'tenant=A&tenant=B', 'state=all', 'principal_id=operator',
    'authorization_id=bad', 'authorization_id=', 'on_behalf_of=', 'principal_id=&tenant=A', 'tenant=%20A',
    'tenant=%00A', 'limit=0', 'limit=101', 'limit=1.5', 'limit=01', 'limit=', 'cursor=', 'cursor=%%%25',
    `tenant=${'x'.repeat(129)}`, `on_behalf_of=${'x'.repeat(192)}`, `cursor=${'a'.repeat(2049)}`,
  ];
  for (const query of queries) assert.equal((await f.call(`/agent-auth/v1/sessions?${query}`)).statusCode, 400, query);
  assert.equal(f.calls.length, 0);
});

test('pagination cursor binds the authenticated client and every filter while allowing a different page size', async () => {
  const f = fixture();
  f.repository.listBusinessSessions = async (input: any) => {
    f.calls.push(['list', input]);
    return { list: [f.session], nextCursor: { createdAt, sessionId } };
  };
  const query = new URLSearchParams({ authorization_id: authorizationId, on_behalf_of: 'tenant-A:operator', principal_id: 'operator', tenant: 'tenant-A', state: 'active', limit: '1' });
  const first = await f.call(`/agent-auth/v1/sessions?${query}`);
  assert.equal(first.statusCode, 200);
  const cursor = first.json().next_cursor;
  query.set('cursor', cursor); query.set('limit', '2');
  assert.equal((await f.call(`/agent-auth/v1/sessions?${query}`)).statusCode, 200);
  assert.deepEqual(f.calls[1][1].cursor, { createdAt, sessionId });
  assert.equal((await f.call(`/agent-auth/v1/sessions?${query}`, 'GET', undefined, f.other.token)).statusCode, 400);
  for (const key of ['authorization_id', 'on_behalf_of', 'principal_id', 'tenant', 'state']) {
    const changed = new URLSearchParams(query); changed.delete(key);
    assert.equal((await f.call(`/agent-auth/v1/sessions?${changed}`)).statusCode, 400, key);
  }
  const malformed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  for (const extra of [{ created_at: '2026-02-30T01:00:00.000Z' }, { session_id: 'other' }, { v: 2 }, { injected: true }]) {
    const changed = new URLSearchParams(query);
    changed.set('cursor', Buffer.from(JSON.stringify({ ...malformed, ...extra })).toString('base64url'));
    assert.equal((await f.call(`/agent-auth/v1/sessions?${changed}`)).statusCode, 400);
  }
  assert.equal(f.calls.length, 2);
});

test('consumed authorization exposes only linked own-session metadata; authorization expiry is separate', async () => {
  const f = fixture();
  const path = `/agent-auth/v1/authorizations/${authorizationId}`;
  const result = await f.call(path);
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().status, 'consumed');
  assert.equal(result.json().expires_at, createdAt);
  assert.deepEqual(result.json().session, { session_id: sessionId, state: 'active', expires_at: expiry, subject_display: null, subject_display_status: 'missing' });
  assert.doesNotMatch(result.body, /secret|code_hash|challenge|redirect_uri|principal/);
  f.session.state = 'revoked'; f.session.revoked_at = createdAt;
  assert.equal((await f.call(path)).json().session.state, 'revoked');
  assert.equal((await f.call(path, 'GET', undefined, f.other.token)).statusCode, 404);
  f.repository.getBusinessSession = async () => null;
  assert.equal((await f.call(path)).json().session, null);
  f.authorization.status = 'pending';
  assert.equal('session' in (await f.call(path)).json(), false);
});

test('authorization revocation passes authenticated identity, rejects unknown body and does not expose repository details', async () => {
  const f = fixture(); const path = `/agent-auth/v1/authorizations/${authorizationId}/revoke`;
  for (const body of [[], null, { client_app_id: 'other' }, { session_id: sessionId }]) {
    assert.equal((await f.call(path, 'POST', body)).statusCode, 400);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call(path, 'POST', {})).statusCode, 200);
  assert.deepEqual(f.calls[0][1], { authorizationId, clientAppId: 'example-business' });
  assert.deepEqual((await f.call(path, 'POST', {})).json(), { authorization_id: authorizationId, revoked: true, session_id: sessionId });
  assert.equal((await f.call(path, 'POST', {}, f.other.token)).statusCode, 404);
  assert.equal((await f.call(path, 'POST', {}, null)).statusCode, 401);
  assert.equal((await f.call(path)).statusCode, 405);
  f.repository.revokeAuthorization = async () => { throw new Error('db-host credential-secret deadlock'); };
  const failed = await f.call(path, 'POST', {});
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), { error: 'agent_auth_lifecycle_unavailable' });
});

test('old hosts explicitly reject new operations while old context remains readable; repository failures never look empty or successful', async () => {
  const f = fixture(); const context = `/agent-auth/v1/authorizations/${authorizationId}`;
  delete f.repository.listBusinessSessions; delete f.repository.revokeAuthorization; delete f.repository.getBusinessSession;
  assert.equal((await f.call('/agent-auth/v1/sessions')).statusCode, 503);
  assert.equal((await f.call(`${context}/revoke`, 'POST', {})).statusCode, 503);
  assert.equal((await f.call(context)).json().session, null);
  f.repository.listBusinessSessions = async () => { throw new Error('query-secret'); };
  const result = await f.call('/agent-auth/v1/sessions');
  assert.equal(result.statusCode, 503); assert.doesNotMatch(result.body, /query-secret|list/);
  f.repository.getAuthorization = async () => { throw new Error('context-secret'); };
  assert.equal((await f.call(context)).statusCode, 503);
  assert.equal((await f.call('/agent-auth/v1/sessions', 'POST', {})).statusCode, 405);
});

test('business HTTP projection fails closed if a custom repository returns another client session', async () => {
  const f = fixture(); f.session.client_app_id = f.other.app_id;
  assert.equal((await f.call('/agent-auth/v1/sessions')).statusCode, 503);
  assert.equal((await f.call(`/agent-auth/v1/authorizations/${authorizationId}`)).statusCode, 503);
});
