import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { AgentSession, Client } from '../core/contracts/types';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { AgentAuthorization } from '../infrastructure/config/config-agent-auth-repository';
import { handleAgentAuthHttpFor, isLoopbackRedirectUri, pkceChallenge, tokenHash } from './agent-auth';

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
  json(): Record<string, any> { return JSON.parse(this.body.toString('utf8')) as Record<string, any>; }
}

function request(method: string, body?: Record<string, unknown>, headers: Record<string, string> = {}): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  req.method = method;
  req.headers = headers;
  Object.defineProperty(req, 'socket', { value: { remoteAddress: '127.0.0.9' } });
  return req;
}

async function call(store: ConfigStoreContract, method: string, path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<FakeResponse> {
  const res = new FakeResponse();
  const handled = await handleAgentAuthHttpFor(
    { configStore: store },
    request(method, body, headers),
    res as unknown as ServerResponse,
    new URL(path, 'https://hub.example.com'),
  );
  assert.equal(handled, true);
  return res;
}

test('Agent Auth loopback redirect only accepts explicit-port IP literals', () => {
  assert.equal(isLoopbackRedirectUri('http://127.0.0.1:43123/callback'), true);
  assert.equal(isLoopbackRedirectUri('http://[::1]:43123/callback'), true);
  assert.equal(isLoopbackRedirectUri('http://localhost:43123/callback'), false);
  assert.equal(isLoopbackRedirectUri('http://2130706433:43123/callback'), false);
  assert.equal(isLoopbackRedirectUri('http://0x7f000001:43123/callback'), false);
  assert.equal(isLoopbackRedirectUri('http://127.0.0.1/callback'), false);
  assert.equal(isLoopbackRedirectUri('https://127.0.0.1:43123/callback'), false);
  assert.equal(isLoopbackRedirectUri('http://user@127.0.0.1:43123/callback'), false);
  assert.equal(isLoopbackRedirectUri('http://127.0.0.1:43123/callback#fragment'), false);
});

test('Agent Auth v1: context is redacted, PKCE binds client/redirect, query tokens fail, and business can revoke', async () => {
  const client: Client = {
    app_id: 'example-business',
    name: 'Example Business',
    token: 'business-client-token-0001',
    agent_authorize_url: 'https://tenant.example.com/agent-authorize?from=hub',
    allowed_routes: ['orders'],
    allowed_channels: [],
    rate_limit_per_min: 0,
    enabled: true,
  };
  const otherClient: Client = { ...client, app_id: 'other-client', name: 'Other', token: 'other-client-token-000001' };
  let authorization: AgentAuthorization | null = null;
  let approvedCodeHash = '';
  let accessHash = '';
  let refreshHash = '';
  let session: AgentSession | null = null;
  let revoked = false;
  let rateLimited = false;

  const agentAuth = {
    async createAuthorization(input: any) {
      authorization = {
        authorization_id: input.authorizationId,
        client_app_id: input.clientAppId,
        redirect_uri: input.redirectUri,
        state: input.state,
        requested_routes: input.requestedRoutes,
        device_label: input.deviceLabel,
        code_challenge: input.codeChallenge,
        status: 'pending',
        created_at: new Date().toISOString(),
        expires_at: input.expiresAt,
      };
    },
    async getAuthorization(id: string) { return authorization?.authorization_id === id ? authorization : null; },
    async approveAuthorization(input: any) {
      if (!authorization || authorization.authorization_id !== input.authorizationId || authorization.status !== 'pending') return { ok: false, reason: 'invalid_state' };
      approvedCodeHash = input.codeHash;
      authorization = {
        ...authorization,
        status: 'approved',
        principal: input.principal,
        on_behalf_of: input.onBehalfOf,
        allowed_routes: input.allowedRoutes,
        code_expires_at: input.codeExpiresAt,
      };
      return { ok: true, authorization };
    },
    async denyAuthorization() { return { ok: false, reason: 'invalid_state' }; },
    async exchangeAuthorizationCode(input: any) {
      if (!authorization || authorization.status !== 'approved' || input.codeHash !== approvedCodeHash ||
          input.clientAppId !== authorization.client_app_id || input.redirectUri !== authorization.redirect_uri ||
          input.codeChallenge !== authorization.code_challenge) return { ok: false, reason: 'invalid_grant' };
      accessHash = input.accessTokenHash;
      refreshHash = input.refreshTokenHash;
      session = {
        session_id: input.sessionId,
        client_app_id: authorization.client_app_id,
        device_label: authorization.device_label,
        principal: authorization.principal!,
        on_behalf_of: authorization.on_behalf_of!,
        allowed_routes: authorization.allowed_routes!,
        created_at: new Date().toISOString(),
        access_expires_at: input.accessExpiresAt,
        refresh_expires_at: input.refreshExpiresAt,
      };
      authorization = { ...authorization, status: 'consumed' };
      return { ok: true, session };
    },
    async rotateRefreshToken() { return { ok: false, reason: 'invalid_grant' }; },
    async getSessionByAccessHash(hash: string) { return !revoked && hash === accessHash ? session : null; },
    async revokeByAccessHash(hash: string) { if (hash === accessHash) revoked = true; return hash === accessHash; },
    async revokeByRefreshHash(_app: string, hash: string) { if (hash === refreshHash) revoked = true; return hash === refreshHash; },
    async revokeSessionForClient(appId: string, sessionId: string) {
      if (session?.client_app_id === appId && session.session_id === sessionId) { revoked = true; return true; }
      return false;
    },
  };
  const store = {
    agentAuth,
    clients: {
      get: async (appId: string) => appId === client.app_id ? client : appId === otherClient.app_id ? otherClient : null,
      getByToken: async (token: string) => token === client.token ? client : token === otherClient.token ? otherClient : null,
    },
    rateLimits: { consume: async () => rateLimited },
  } as unknown as ConfigStoreContract;

  const verifier = 'v'.repeat(43);
  const redirectUri = 'http://127.0.0.1:43123/callback?local=1';
  const created = await call(store, 'POST', '/agent-auth/v1/authorizations', {
    client_app_id: client.app_id,
    redirect_uri: redirectUri,
    state: 'state-12345678',
    requested_routes: ['orders'],
    device_label: 'Mac mini',
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().expires_in, 600);
  const authorizationId = String(created.json().authorization_id);
  const authorizeUrl = new URL(String(created.json().authorization_url));
  assert.equal(authorizeUrl.origin, 'https://tenant.example.com');
  assert.equal(authorizeUrl.searchParams.get('from'), 'hub');
  assert.equal(authorizeUrl.searchParams.get('authorization_id'), authorizationId);

  const autoRoute = await call(store, 'POST', '/agent-auth/v1/authorizations', {
    client_app_id: client.app_id,
    redirect_uri: 'http://127.0.0.1:43124/callback',
    state: 'state-87654321',
    requested_routes: ['auto'],
    device_label: 'Mac mini',
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  });
  assert.equal(autoRoute.statusCode, 400);
  const wildcardRoute = await call(store, 'POST', '/agent-auth/v1/authorizations', {
    client_app_id: client.app_id,
    redirect_uri: 'http://127.0.0.1:43126/callback',
    state: 'state-66778899',
    requested_routes: ['*'],
    device_label: 'Mac mini',
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  });
  assert.equal(wildcardRoute.statusCode, 400);

  rateLimited = true;
  const throttled = await call(store, 'POST', '/agent-auth/v1/authorizations', {
    client_app_id: client.app_id,
    redirect_uri: 'http://127.0.0.1:43125/callback',
    state: 'state-11223344',
    requested_routes: ['orders'],
    device_label: 'Mac mini',
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  });
  assert.equal(throttled.statusCode, 429);
  rateLimited = false;

  const queryToken = await call(store, 'GET', `/agent-auth/v1/authorizations/${authorizationId}?token=${encodeURIComponent(client.token)}`);
  assert.equal(queryToken.statusCode, 401);
  const context = await call(store, 'GET', `/agent-auth/v1/authorizations/${authorizationId}`, undefined, { authorization: `Bearer ${client.token}` });
  assert.equal(context.statusCode, 200);
  assert.deepEqual(context.json(), {
    authorization_id: authorizationId,
    client: { app_id: client.app_id, name: client.name },
    device: { name: 'Mac mini' },
    requested_routes: ['orders'],
    status: 'pending',
    expires_at: authorization!.expires_at,
  });
  for (const secretField of ['redirect_uri', 'state', 'code_challenge']) assert.equal(secretField in context.json(), false);

  const approveAuto = await call(store, 'POST', `/agent-auth/v1/authorizations/${authorizationId}/approve`, {
    principal: { id: 'user-7', tenant: 'tenant-2', roles: ['manager'] },
    on_behalf_of: 'tenant-2:user-7',
    allowed_routes: ['auto'],
  }, { authorization: `Bearer ${client.token}` });
  assert.equal(approveAuto.statusCode, 400);
  const approveWildcard = await call(store, 'POST', `/agent-auth/v1/authorizations/${authorizationId}/approve`, {
    principal: { id: 'user-7', tenant: 'tenant-2', roles: ['manager'] },
    on_behalf_of: 'tenant-2:user-7',
    allowed_routes: ['*'],
  }, { authorization: `Bearer ${client.token}` });
  assert.equal(approveWildcard.statusCode, 400);

  const approved = await call(store, 'POST', `/agent-auth/v1/authorizations/${authorizationId}/approve`, {
    principal: { id: 'user-7', tenant: 'tenant-2', roles: ['manager'] },
    on_behalf_of: 'tenant-2:user-7',
    allowed_routes: ['orders'],
  }, { authorization: `Bearer ${client.token}` });
  assert.equal(approved.statusCode, 200);
  assert.match(approvedCodeHash, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(authorization!.code_expires_at!) - Date.now() <= 120_000);
  const redirect = new URL(String(approved.json().redirect_uri));
  const code = String(redirect.searchParams.get('code'));
  assert.equal(redirect.origin + redirect.pathname, 'http://127.0.0.1:43123/callback');
  assert.equal(redirect.searchParams.get('local'), '1');
  assert.equal(redirect.searchParams.get('state'), 'state-12345678');
  assert.equal(tokenHash(code), approvedCodeHash);

  const mixedUp = await call(store, 'POST', '/agent-auth/v1/token', {
    grant_type: 'authorization_code', client_app_id: otherClient.app_id, code, redirect_uri: redirectUri, code_verifier: verifier,
  });
  assert.equal(mixedUp.statusCode, 400);
  assert.equal(mixedUp.json().error, 'invalid_grant');

  const token = await call(store, 'POST', '/agent-auth/v1/token', {
    grant_type: 'authorization_code', client_app_id: client.app_id, code, redirect_uri: redirectUri, code_verifier: verifier,
  });
  assert.equal(token.statusCode, 200);
  assert.equal(token.headers['cache-control'], 'no-store');
  assert.equal(token.headers['pragma'], 'no-cache');
  assert.deepEqual(Object.keys(token.json()).sort(), ['access_token', 'client_app_id', 'expires_in', 'refresh_expires_in', 'refresh_token', 'session_id', 'token_type'].sort());
  const accessToken = String(token.json().access_token);

  const queryAccess = await call(store, 'GET', `/agent-auth/v1/session?token=${encodeURIComponent(accessToken)}`);
  assert.equal(queryAccess.statusCode, 401);
  const current = await call(store, 'GET', '/agent-auth/v1/session', undefined, { authorization: `Bearer ${accessToken}` });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().principal.id, 'user-7');
  assert.equal(current.json().on_behalf_of, 'tenant-2:user-7');

  const savedAuthorizeUrl = client.agent_authorize_url;
  client.agent_authorize_url = 'http://business.example.com/agent-authorize';
  const invalidConfig = await call(store, 'GET', '/agent-auth/v1/session', undefined, { authorization: `Bearer ${accessToken}` });
  assert.equal(invalidConfig.statusCode, 401);
  client.agent_authorize_url = savedAuthorizeUrl;
  client.enabled = false;
  const disabledClient = await call(store, 'GET', '/agent-auth/v1/session', undefined, { authorization: `Bearer ${accessToken}` });
  assert.equal(disabledClient.statusCode, 401);
  client.enabled = true;

  const revokedByBusiness = await call(store, 'POST', `/agent-auth/v1/sessions/${token.json().session_id}/revoke`, {}, { authorization: `Bearer ${client.token}` });
  assert.equal(revokedByBusiness.statusCode, 200);
  const afterRevoke = await call(store, 'GET', '/agent-auth/v1/session', undefined, { authorization: `Bearer ${accessToken}` });
  assert.equal(afterRevoke.statusCode, 401);
});
