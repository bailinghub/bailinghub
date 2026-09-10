import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { namedRateLimitedFor } from '../app/auth';
import { ipOf, readBody, send } from '../app/http';
import type { AgentBusinessPrincipal, AgentSession, Client } from '../core/contracts/types';
import { agentSubjectDisplayView, validateAgentSubjectDisplay } from '../core/contracts/agent-subject-display';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export const AGENT_AUTHORIZATION_TTL_SEC = 10 * 60;
export const AGENT_AUTHORIZATION_CODE_TTL_SEC = 2 * 60;
export const AGENT_ACCESS_TTL_SEC = 15 * 60;
export const AGENT_REFRESH_TTL_SEC = 30 * 24 * 60 * 60;

const RESOURCE_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RecordValue = Record<string, unknown>;
type BusinessSession = AgentSession & {
  state: 'active' | 'expired' | 'revoked';
  authorization_id?: string;
  last_seen_at?: string;
};
type SessionListFilters = {
  authorizationId?: string;
  onBehalfOf?: string;
  principalId?: string;
  tenant?: string;
  state?: BusinessSession['state'];
};
type SessionCursor = { createdAt: string; sessionId: string };

export interface AgentAuthHttpDeps {
  configStore: ConfigStoreContract | null;
}

function record(value: unknown): RecordValue | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}

function allowedFields(value: RecordValue, fields: readonly string[]): boolean {
  const known = new Set(fields);
  return Object.keys(value).every((key) => known.has(key));
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return null;
  const items = value.map((item) => typeof item === 'string' ? item.trim() : '');
  if (items.some((item) => !item || item === 'auto' || item === '*' || !RESOURCE_RE.test(item))) return null;
  const unique = [...new Set(items)];
  return unique.length === items.length ? unique : null;
}

function hasStrictLoopbackHttpAuthority(value: string): boolean {
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([0-9]{1,5})(?:[/?#]|$)/i.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isAgentAuthorizeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopbackDev = hasStrictLoopbackHttpAuthority(value) && (hostname === '127.0.0.1' || hostname === '::1');
    return (url.protocol === 'https:' || loopbackDev) && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function isLoopbackRedirectUri(value: string): boolean {
  if (!value || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = hostname === '127.0.0.1' || hostname === '::1';
    return url.protocol === 'http:' && loopback && hasStrictLoopbackHttpAuthority(value) && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function tokenHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

function randomSecret(prefix: 'bha' | 'bhr' | 'bhc'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

function authorizationUrl(base: string, authorizationId: string): string | null {
  if (!isAgentAuthorizeUrl(base) || base.length > 2048) return null;
  const url = new URL(base);
  url.searchParams.set('authorization_id', authorizationId);
  return url.toString();
}

function redirectResult(base: string, result: { code?: string; error?: string }, state: string): string {
  const url = new URL(base);
  url.searchParams.delete('code');
  url.searchParams.delete('error');
  if (result.code) url.searchParams.set('code', result.code);
  if (result.error) url.searchParams.set('error', result.error);
  url.searchParams.set('state', state);
  return url.toString();
}

function clientAllowsRoute(client: Client, route: string): boolean {
  return client.allowed_routes.includes('*') || client.allowed_routes.includes(route);
}

function requestedAllowsRoute(requested: string[], route: string): boolean {
  return requested.includes('*') || requested.includes(route);
}

function parsePrincipal(value: unknown): AgentBusinessPrincipal | null {
  const item = record(value);
  if (!item || !allowedFields(item, ['id', 'tenant', 'roles', 'audience', 'channel'])) return null;
  const id = typeof item['id'] === 'string' ? item['id'].trim() : '';
  const tenant = typeof item['tenant'] === 'string' ? item['tenant'].trim() : '';
  const audience = typeof item['audience'] === 'string' ? item['audience'].trim() : '';
  const channel = typeof item['channel'] === 'string' ? item['channel'].trim() : '';
  const roles = Array.isArray(item['roles'])
    ? item['roles'].map((role) => typeof role === 'string' ? role.trim() : '')
    : [];
  if (!id || id.length > 128 || tenant.length > 128 || audience.length > 64 || channel.length > 128 ||
      roles.length > 64 || roles.some((role) => !role || role.length > 64)) return null;
  return {
    id,
    ...(tenant ? { tenant } : {}),
    roles: [...new Set(roles)],
    ...(audience ? { audience } : {}),
    ...(channel ? { channel } : {}),
  };
}

async function businessClient(deps: AgentAuthHttpDeps, req: IncomingMessage, url: URL): Promise<Client | null> {
  const token = bearerToken(req);
  if (!token || !deps.configStore) return null;
  const client = await deps.configStore.clients.getByToken(token);
  return client?.enabled ? client : null;
}

function bearerToken(req: IncomingMessage): string {
  const header = (req.headers['authorization'] ?? '').toString();
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1] ?? '';
}

function publicSession(session: AgentSession): RecordValue {
  return {
    session_id: session.session_id,
    client_app_id: session.client_app_id,
    device_label: session.device_label,
    ...agentSubjectDisplayView(session.subject_display),
    principal: session.principal,
    on_behalf_of: session.on_behalf_of,
    allowed_routes: session.allowed_routes,
    created_at: session.created_at,
    expires_at: session.access_expires_at,
    refresh_expires_at: session.refresh_expires_at,
  };
}

/** Business metadata never includes credential material, including unknown nested fields. */
function businessSessionMetadata(session: BusinessSession): RecordValue {
  const source = session.principal;
  const principal = parsePrincipal({
    id: source.id, tenant: source.tenant, roles: source.roles, audience: source.audience, channel: source.channel,
  });
  const allowedRoutes = stringList(session.allowed_routes);
  if (!principal || !allowedRoutes || !UUID_RE.test(session.session_id) || !['active', 'expired', 'revoked'].includes(session.state)) {
    throw new Error('Invalid business session metadata');
  }
  return {
    session_id: session.session_id,
    ...(session.authorization_id ? { authorization_id: session.authorization_id } : {}),
    client_app_id: session.client_app_id,
    device_label: session.device_label,
    ...agentSubjectDisplayView(session.subject_display),
    principal,
    on_behalf_of: session.on_behalf_of,
    allowed_routes: allowedRoutes,
    state: session.state,
    created_at: session.created_at,
    expires_at: session.refresh_expires_at,
    ...(session.last_seen_at ? { last_seen_at: session.last_seen_at } : {}),
    ...(session.revoked_at ? { revoked_at: session.revoked_at } : {}),
  };
}

function sessionCursorBinding(clientAppId: string, filters: SessionListFilters): string {
  // This digest binds pagination to public filters; it is not a credential or authorization grant.
  return createHash('sha256').update(JSON.stringify([
    clientAppId, filters.authorizationId ?? null, filters.onBehalfOf ?? null,
    filters.principalId ?? null, filters.tenant ?? null, filters.state ?? null,
  ])).digest('hex');
}

function parseSessionList(url: URL, clientAppId: string): { filters: SessionListFilters; limit: number; cursor?: SessionCursor; binding: string } | null {
  const params = url.searchParams;
  const fields = ['authorization_id', 'on_behalf_of', 'principal_id', 'tenant', 'state', 'limit', 'cursor'];
  for (const key of params.keys()) if (!fields.includes(key) || params.getAll(key).length !== 1) return null;
  const filters: SessionListFilters = {};
  if (params.has('authorization_id')) {
    const value = params.get('authorization_id')!;
    if (!UUID_RE.test(value)) return null;
    filters.authorizationId = value.toLowerCase();
  }
  for (const [key, property, max] of [
    ['on_behalf_of', 'onBehalfOf', 191], ['principal_id', 'principalId', 128], ['tenant', 'tenant', 128],
  ] as const) {
    if (!params.has(key)) continue;
    const value = params.get(key)!;
    if ((key !== 'tenant' && !value) || value.length > max || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
    filters[property] = value;
  }
  if (filters.principalId !== undefined && filters.tenant === undefined) return null;
  if (params.has('state')) {
    const state = params.get('state')!;
    if (state !== 'active' && state !== 'expired' && state !== 'revoked') return null;
    filters.state = state;
  }
  const rawLimit = params.get('limit') ?? '20';
  if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) return null;
  const binding = sessionCursorBinding(clientAppId, filters);
  let cursor: SessionCursor | undefined;
  if (params.has('cursor')) {
    const raw = params.get('cursor')!;
    if (!raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
    try {
      const bytes = Buffer.from(raw, 'base64url');
      if (bytes.toString('base64url') !== raw) return null;
      const value = record(JSON.parse(bytes.toString('utf8')));
      if (!value || !allowedFields(value, ['v', 'binding', 'created_at', 'session_id']) || value['v'] !== 1 || value['binding'] !== binding ||
          typeof value['created_at'] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value['created_at']) ||
          new Date(value['created_at']).toISOString() !== value['created_at'] || typeof value['session_id'] !== 'string' || !UUID_RE.test(value['session_id'])) return null;
      cursor = { createdAt: value['created_at'], sessionId: value['session_id'].toLowerCase() };
    } catch { return null; }
  }
  return { filters, limit: Number(rawLimit), ...(cursor ? { cursor } : {}), binding };
}

async function businessListSessions(deps: AgentAuthHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const repository = deps.configStore?.agentAuth;
    if (!repository) { send(res, 503, { error: 'agent_auth_unavailable' }); return; }
    const client = await businessClient(deps, req, url);
    if (!client) { send(res, 401, { error: 'unauthorized' }); return; }
    const input = parseSessionList(url, client.app_id);
    if (!input) { send(res, 400, { error: 'invalid_request' }); return; }
    if (typeof repository.listBusinessSessions !== 'function') { send(res, 503, { error: 'agent_auth_lifecycle_unavailable' }); return; }
    const result = await repository.listBusinessSessions({ clientAppId: client.app_id, ...input.filters, limit: input.limit, cursor: input.cursor });
    if (result.list.length > input.limit || result.list.some((session) => session.client_app_id !== client.app_id)) {
      throw new Error('Invalid business session scope');
    }
    send(res, 200, {
      list: result.list.map(businessSessionMetadata),
      next_cursor: result.nextCursor ? Buffer.from(JSON.stringify({
        v: 1, binding: input.binding, created_at: result.nextCursor.createdAt, session_id: result.nextCursor.sessionId,
      })).toString('base64url') : null,
    });
  } catch { send(res, 503, { error: 'agent_auth_lifecycle_unavailable' }); }
}

async function createAuthorization(deps: AgentAuthHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!deps.configStore?.agentAuth) { send(res, 503, { error: 'agent_auth_unavailable' }); return; }
  const body = record(await readBody(req).catch(() => null));
  if (!body || !allowedFields(body, ['client_app_id', 'redirect_uri', 'state', 'requested_routes', 'device_label', 'code_challenge', 'code_challenge_method'])) {
    send(res, 400, { error: 'invalid_request' }); return;
  }
  const clientAppId = typeof body['client_app_id'] === 'string' ? body['client_app_id'].trim() : '';
  const redirectUri = typeof body['redirect_uri'] === 'string' ? body['redirect_uri'] : '';
  const state = typeof body['state'] === 'string' ? body['state'] : '';
  const requestedRoutes = stringList(body['requested_routes']);
  const deviceLabel = typeof body['device_label'] === 'string' ? body['device_label'].trim() : '';
  const codeChallenge = typeof body['code_challenge'] === 'string' ? body['code_challenge'] : '';
  if (!RESOURCE_RE.test(clientAppId) || !isLoopbackRedirectUri(redirectUri) || state.length < 8 || state.length > 512 ||
      !requestedRoutes || !deviceLabel || deviceLabel.length > 128 || !PKCE_CHALLENGE_RE.test(codeChallenge) || body['code_challenge_method'] !== 'S256') {
    send(res, 400, { error: 'invalid_request' }); return;
  }
  const client = await deps.configStore.clients.get(clientAppId);
  if (!client?.enabled || !client.agent_authorize_url || requestedRoutes.some((route) => !clientAllowsRoute(client, route))) {
    send(res, 400, { error: 'invalid_client' }); return;
  }
  if (await namedRateLimitedFor(deps.configStore, `agent-auth:create:${clientAppId}:${ipOf(req)}`, 10, 60)) {
    send(res, 429, { error: 'rate_limited' }); return;
  }
  const authorizationId = randomUUID();
  const authorizeUrl = authorizationUrl(client.agent_authorize_url, authorizationId);
  if (!authorizeUrl) { send(res, 503, { error: 'agent_authorize_url_invalid' }); return; }
  const expiresAt = new Date(Date.now() + AGENT_AUTHORIZATION_TTL_SEC * 1000).toISOString();
  await deps.configStore.agentAuth.createAuthorization({
    authorizationId,
    clientAppId,
    redirectUri,
    state,
    requestedRoutes,
    deviceLabel,
    codeChallenge,
    expiresAt,
  });
  send(res, 201, { authorization_id: authorizationId, authorization_url: authorizeUrl, expires_in: AGENT_AUTHORIZATION_TTL_SEC });
}

async function authorizationContext(deps: AgentAuthHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL, authorizationId: string): Promise<void> {
  try {
    if (!deps.configStore?.agentAuth) { send(res, 503, { error: 'agent_auth_unavailable' }); return; }
    const client = await businessClient(deps, req, url);
    if (!client) { send(res, 401, { error: 'unauthorized' }); return; }
    const item = await deps.configStore.agentAuth.getAuthorization(authorizationId);
    if (!item || item.client_app_id !== client.app_id) { send(res, 404, { error: 'not_found' }); return; }
    const status = item.status === 'pending' && Date.parse(item.expires_at) <= Date.now() ? 'expired' : item.status;
    let session: RecordValue | null = null;
    if (item.status === 'consumed' && item.session_id && typeof deps.configStore.agentAuth.getBusinessSession === 'function') {
      const linked = await deps.configStore.agentAuth.getBusinessSession(client.app_id, item.session_id);
      if (linked) {
        if (linked.client_app_id !== client.app_id || linked.session_id !== item.session_id) throw new Error('Invalid business session scope');
        const metadata = businessSessionMetadata(linked);
        session = { session_id: linked.session_id, state: metadata['state'], expires_at: metadata['expires_at'],
          ...agentSubjectDisplayView(linked.subject_display),
          ...(linked.revoked_at ? { revoked_at: linked.revoked_at } : {}) };
      }
    }
    send(res, 200, {
      authorization_id: item.authorization_id,
      client: { app_id: client.app_id, name: client.name },
      device: { name: item.device_label },
      requested_routes: item.requested_routes,
      status,
      expires_at: item.expires_at,
      ...(item.status === 'consumed' ? { session } : {}),
    });
  } catch { send(res, 503, { error: 'agent_auth_lifecycle_unavailable' }); }
}

async function businessRevokeAuthorization(deps: AgentAuthHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL, authorizationId: string): Promise<void> {
  try {
    const repository = deps.configStore?.agentAuth;
    if (!repository) { send(res, 503, { error: 'agent_auth_unavailable' }); return; }
    const client = await businessClient(deps, req, url);
    if (!client) { send(res, 401, { error: 'unauthorized' }); return; }
    const body = record(await readBody(req, 4096).catch(() => null));
    if (!body || !allowedFields(body, [])) { send(res, 400, { error: 'invalid_request' }); return; }
    if (typeof repository.revokeAuthorization !== 'function') { send(res, 503, { error: 'agent_auth_lifecycle_unavailable' }); return; }
    const result = await repository.revokeAuthorization({ authorizationId, clientAppId: client.app_id });
    if (!result.ok) { send(res, 404, { error: 'not_found' }); return; }
    if (result.authorization.authorization_id !== authorizationId || result.authorization.client_app_id !== client.app_id) throw new Error('Invalid authorization scope');
    send(res, 200, { authorization_id: authorizationId, revoked: true, ...(result.sessionId ? { session_id: result.sessionId } : {}) });
  } catch { send(res, 503, { error: 'agent_auth_lifecycle_unavailable' }); }
}

async function approveAuthorization(deps: AgentAuthHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL, authorizationId: string): Promise<void> {
  if (!deps.configStore?.agentAuth) { send(res, 503, { error: 'agent_auth_unavailable' }); return; }
  const client = await businessClient(deps, req, url);
  if (!client) { send(res, 401, { error: 'unauthorized' }); return; }
  const body = record(await readBody(req).catch(() => null));
  if (!body || !allowedFields(body, ['principal', 'on_behalf_of', 'allowed_routes', 'subject_display'])) { send(res, 400, { error: 'invalid_request' }); return; }
  const display = validateAgentSubjectDisplay(body['subject_display']);
  if (!display.ok) { send(res, 400, { error: 'invalid_request' }); return; }
  if (display.value && typeof deps.configStore.agentAuth.updateSubjectDisplay !== 'function') {
    send(res, 503, { error: 'subject_display_unavailable' }); return;
  }
  const principal = parsePrincipal(body['principal']);
  const onBehalfOf = typeof body['on_behalf_of'] === 'string' ? body['on_behalf_of'].trim() : '';
  const allowedRoutes = stringList(body['allowed_routes']);
  if (!principal || !onBehalfOf || onBehalfOf.length > 191 || !allowedRoutes) { send(res, 400, { error: 'invalid_request' }); return; }
  const pending = await deps.configStore.agentAuth.getAuthorization(authorizationId);
  if (!pending || pending.client_app_id !== client.app_id) { send(res, 404, { error: 'not_found' }); return; }
  if (allowedRoutes.some((route) => !requestedAllowsRoute(pending.requested_routes, route) || !clientAllowsRoute(client, route))) {
    send(res, 403, { error: 'route_not_allowed' }); return;
  }
  const code = randomSecret('bhc');
  const result = await deps.configStore.agentAuth.approveAuthorization({
    authorizationId,
    clientAppId: client.app_id,
    principal: { ...principal },
    subjectDisplay: display.value,
    onBehalfOf,
    allowedRoutes,
    codeHash: tokenHash(code),
    codeExpiresAt: new Date(Date.now() + AGENT_AUTHORIZATION_CODE_TTL_SEC * 1000).toISOString(),
  });
  if (!result.ok) {
    const status = result.reason === 'not_found' || result.reason === 'wrong_client' ? 404 : result.reason === 'expired' ? 410 : 409;
    send(res, status, { error: result.reason }); return;
  }
  send(res, 200, { redirect_uri: redirectResult(result.authorization.redirect_uri, { code }, result.authorization.state) });
}

async function denyAuthorization(deps: AgentAuthHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL, authorizationId: string): Promise<void> {
  if (!deps.configStore?.agentAuth) { send(res, 503, { error: 'agent_auth_unavailable' }); return; }
  const client = await businessClient(deps, req, url);
  if (!client) { send(res, 401, { error: 'unauthorized' }); return; }
  const body = record(await readBody(req).catch(() => ({}))) ?? {};
  if (!allowedFields(body, [])) { send(res, 400, { error: 'invalid_request' }); return; }
  const result = await deps.configStore.agentAuth.denyAuthorization({ authorizationId, clientAppId: client.app_id });
  if (!result.ok) {
    const status = result.reason === 'not_found' || result.reason === 'wrong_client' ? 404 : result.reason === 'expired' ? 410 : 409;
    send(res, status, { error: result.reason }); return;
  }
  send(res, 200, { redirect_uri: redirectResult(result.authorization.redirect_uri, { error: 'access_denied' }, result.authorization.state) });
}

function tokenResponse(session: AgentSession, accessToken: string, refreshToken: string): RecordValue {
  return {
    token_type: 'Bearer',
    access_token: accessToken,
    expires_in: AGENT_ACCESS_TTL_SEC,
    refresh_token: refreshToken,
    refresh_expires_in: Math.max(0, Math.floor((Date.parse(session.refresh_expires_at) - Date.now()) / 1000)),
    session_id: session.session_id,
    client_app_id: session.client_app_id,
    ...agentSubjectDisplayView(session.subject_display),
  };
}

async function exchangeToken(deps: AgentAuthHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!deps.configStore?.agentAuth) { send(res, 503, { error: 'agent_auth_unavailable' }); return; }
  const body = record(await readBody(req).catch(() => null));
  if (!body || typeof body['grant_type'] !== 'string') { send(res, 400, { error: 'invalid_request' }); return; }
  const clientAppId = typeof body['client_app_id'] === 'string' ? body['client_app_id'].trim() : '';
  if (!RESOURCE_RE.test(clientAppId)) { send(res, 400, { error: 'invalid_request' }); return; }
  const client = await deps.configStore.clients.get(clientAppId);
  if (!client?.enabled || !client.agent_authorize_url || !isAgentAuthorizeUrl(client.agent_authorize_url)) { send(res, 400, { error: 'invalid_grant' }); return; }
  const accessToken = randomSecret('bha');
  const refreshToken = randomSecret('bhr');
  const accessExpiresAt = new Date(Date.now() + AGENT_ACCESS_TTL_SEC * 1000).toISOString();
  const refreshExpiresAt = new Date(Date.now() + AGENT_REFRESH_TTL_SEC * 1000).toISOString();

  if (body['grant_type'] === 'authorization_code') {
    if (!allowedFields(body, ['grant_type', 'client_app_id', 'code', 'redirect_uri', 'code_verifier'])) { send(res, 400, { error: 'invalid_request' }); return; }
    const code = typeof body['code'] === 'string' ? body['code'] : '';
    const redirectUri = typeof body['redirect_uri'] === 'string' ? body['redirect_uri'] : '';
    const verifier = typeof body['code_verifier'] === 'string' ? body['code_verifier'] : '';
    if (!code.startsWith('bhc_') || code.length < 40 || !isLoopbackRedirectUri(redirectUri) || !PKCE_VERIFIER_RE.test(verifier)) {
      send(res, 400, { error: 'invalid_grant' }); return;
    }
    const result = await deps.configStore.agentAuth.exchangeAuthorizationCode({
      codeHash: tokenHash(code),
      clientAppId,
      redirectUri,
      codeChallenge: pkceChallenge(verifier),
      sessionId: randomUUID(),
      accessTokenHash: tokenHash(accessToken),
      refreshTokenHash: tokenHash(refreshToken),
      accessExpiresAt,
      refreshExpiresAt,
    });
    if (!result.ok) { send(res, 400, { error: 'invalid_grant' }); return; }
    send(res, 200, tokenResponse(result.session, accessToken, refreshToken));
    return;
  }

  if (body['grant_type'] === 'refresh_token') {
    if (!allowedFields(body, ['grant_type', 'client_app_id', 'refresh_token'])) { send(res, 400, { error: 'invalid_request' }); return; }
    const current = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : '';
    if (!current.startsWith('bhr_') || current.length < 40) { send(res, 400, { error: 'invalid_grant' }); return; }
    const result = await deps.configStore.agentAuth.rotateRefreshToken({
      refreshTokenHash: tokenHash(current),
      clientAppId,
      accessTokenHash: tokenHash(accessToken),
      nextRefreshTokenHash: tokenHash(refreshToken),
      accessExpiresAt,
    });
    if (!result.ok) { send(res, 400, { error: 'invalid_grant' }); return; }
    send(res, 200, tokenResponse(result.session, accessToken, refreshToken));
    return;
  }

  send(res, 400, { error: 'unsupported_grant_type' });
}

export async function authenticateAgentAccess(deps: AgentAuthHttpDeps, req: IncomingMessage, url: URL): Promise<{ session: AgentSession; client: Client } | null> {
  if (!deps.configStore?.agentAuth) return null;
  const token = bearerToken(req);
  if (!token.startsWith('bha_') || token.length < 40) return null;
  const session = await deps.configStore.agentAuth.getSessionByAccessHash(tokenHash(token));
  if (!session) return null;
  const client = await deps.configStore.clients.get(session.client_app_id);
  return client?.enabled && client.agent_authorize_url && isAgentAuthorizeUrl(client.agent_authorize_url) ? { session, client } : null;
}

async function readSession(deps: AgentAuthHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = await authenticateAgentAccess(deps, req, url);
  if (!auth) { send(res, 401, { error: 'unauthorized' }); return; }
  send(res, 200, publicSession(auth.session));
}

async function revokeSession(deps: AgentAuthHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!deps.configStore?.agentAuth) { send(res, 503, { error: 'agent_auth_unavailable' }); return; }
  const token = bearerToken(req);
  if (token) {
    if (!token.startsWith('bha_')) { send(res, 401, { error: 'unauthorized' }); return; }
    await deps.configStore.agentAuth.revokeByAccessHash(tokenHash(token));
    send(res, 200, { revoked: true });
    return;
  }
  const body = record(await readBody(req).catch(() => null));
  if (!body || !allowedFields(body, ['client_app_id', 'refresh_token'])) { send(res, 400, { error: 'invalid_request' }); return; }
  const clientAppId = typeof body['client_app_id'] === 'string' ? body['client_app_id'].trim() : '';
  const refreshToken = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : '';
  if (!RESOURCE_RE.test(clientAppId) || !refreshToken.startsWith('bhr_')) { send(res, 400, { error: 'invalid_request' }); return; }
  await deps.configStore.agentAuth.revokeByRefreshHash(clientAppId, tokenHash(refreshToken));
  send(res, 200, { revoked: true });
}

async function businessRevokeSession(deps: AgentAuthHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL, sessionId: string): Promise<void> {
  if (!deps.configStore?.agentAuth) { send(res, 503, { error: 'agent_auth_unavailable' }); return; }
  const client = await businessClient(deps, req, url);
  if (!client) { send(res, 401, { error: 'unauthorized' }); return; }
  if (!UUID_RE.test(sessionId)) { send(res, 404, { error: 'not_found' }); return; }
  const revoked = await deps.configStore.agentAuth.revokeSessionForClient(client.app_id, sessionId);
  if (!revoked) { send(res, 404, { error: 'not_found' }); return; }
  send(res, 200, { revoked: true });
}

async function businessUpdateSubjectDisplay(deps: AgentAuthHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL, sessionId: string): Promise<void> {
  const repository = deps.configStore?.agentAuth;
  if (!repository) { send(res, 503, { error: 'agent_auth_unavailable' }); return; }
  const client = await businessClient(deps, req, url);
  if (!client) { send(res, 401, { error: 'unauthorized' }); return; }
  const body = record(await readBody(req, 4096).catch(() => null));
  if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'subject_display')) {
    send(res, 400, { error: 'invalid_request' }); return;
  }
  const display = validateAgentSubjectDisplay(body['subject_display']);
  if (!display.ok) { send(res, 400, { error: 'invalid_request' }); return; }
  if (typeof repository.updateSubjectDisplay !== 'function') { send(res, 503, { error: 'subject_display_unavailable' }); return; }
  try {
    const result = await repository.updateSubjectDisplay({ clientAppId: client.app_id, sessionId, subjectDisplay: display.value });
    if (!result.ok) {
      send(res, result.reason === 'not_found' ? 404 : 409, { error: result.reason === 'not_found' ? 'not_found' : 'session_inactive' });
      return;
    }
    if (result.session.client_app_id !== client.app_id || result.session.session_id !== sessionId) throw new Error('Invalid subject display binding.');
    send(res, 200, businessSessionMetadata(result.session));
  } catch { send(res, 503, { error: 'subject_display_unavailable' }); }
}

/** Returns true when the request belongs to the dedicated Agent Auth surface. */
export async function handleAgentAuthHttpFor(deps: AgentAuthHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (!path.startsWith('/agent-auth/')) return false;
  res.setHeader('cache-control', 'no-store');
  if (path === '/agent-auth/v1/token') res.setHeader('pragma', 'no-cache');
  if (method === 'POST' && path === '/agent-auth/v1/authorizations') { await createAuthorization(deps, req, res); return true; }
  const authorizationMatch = path.match(/^\/agent-auth\/v1\/authorizations\/([0-9a-f-]{36})(?:\/(approve|deny|revoke))?$/i);
  if (authorizationMatch) {
    const id = authorizationMatch[1]!;
    const action = authorizationMatch[2];
    if (!UUID_RE.test(id)) { send(res, 404, { error: 'not_found' }); return true; }
    if (method === 'GET' && !action) { await authorizationContext(deps, req, res, url, id); return true; }
    if (method === 'POST' && action === 'approve') { await approveAuthorization(deps, req, res, url, id); return true; }
    if (method === 'POST' && action === 'deny') { await denyAuthorization(deps, req, res, url, id); return true; }
    if (method === 'POST' && action === 'revoke') { await businessRevokeAuthorization(deps, req, res, url, id.toLowerCase()); return true; }
    send(res, 405, { error: 'method_not_allowed' }); return true;
  }
  if (method === 'POST' && path === '/agent-auth/v1/token') { await exchangeToken(deps, req, res); return true; }
  if (method === 'GET' && path === '/agent-auth/v1/session') { await readSession(deps, req, res, url); return true; }
  if (path === '/agent-auth/v1/sessions') {
    if (method === 'GET') await businessListSessions(deps, req, res, url);
    else send(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  const displayMatch = path.match(/^\/agent-auth\/v1\/sessions\/([0-9a-f-]{36})\/subject-display$/i);
  if (displayMatch) {
    const sessionId = displayMatch[1]!.toLowerCase();
    if (!UUID_RE.test(sessionId)) { send(res, 404, { error: 'not_found' }); return true; }
    if (method === 'PUT') await businessUpdateSubjectDisplay(deps, req, res, url, sessionId);
    else send(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  if (method === 'POST' && path === '/agent-auth/v1/revoke') { await revokeSession(deps, req, res, url); return true; }
  const revokeMatch = method === 'POST' ? path.match(/^\/agent-auth\/v1\/sessions\/([0-9a-f-]{36})\/revoke$/i) : null;
  if (revokeMatch) { await businessRevokeSession(deps, req, res, url, revokeMatch[1]!); return true; }
  send(res, 404, { error: 'not_found' }); return true;
}
