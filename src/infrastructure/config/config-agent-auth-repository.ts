import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { dt, dtIso } from '../../core/config/config-codec';
import type { AgentBusinessPrincipal, AgentSession } from '../../core/contracts/types';

export type AgentAuthorizationStatus = 'pending' | 'approved' | 'consumed' | 'denied' | 'expired' | 'revoked';

export interface AgentAuthorization {
  authorization_id: string;
  client_app_id: string;
  redirect_uri: string;
  state: string;
  requested_routes: string[];
  device_label: string;
  code_challenge: string;
  status: AgentAuthorizationStatus;
  principal?: AgentBusinessPrincipal;
  on_behalf_of?: string;
  allowed_routes?: string[];
  created_at: string;
  expires_at: string;
  code_expires_at?: string;
  session_id?: string;
}

export type AuthorizationMutationResult =
  | { ok: true; authorization: AgentAuthorization }
  | { ok: false; reason: 'not_found' | 'wrong_client' | 'expired' | 'invalid_state' };

export type AuthorizationExchangeResult =
  | { ok: true; session: AgentSession }
  | { ok: false; reason: 'invalid_grant' };

export type AuthorizationRevocationResult =
  | { ok: true; authorization: AgentAuthorization; sessionId?: string }
  | { ok: false; reason: 'not_found' | 'wrong_client' };

export type RefreshRotationResult =
  | { ok: true; session: AgentSession }
  | { ok: false; reason: 'invalid_grant' | 'replayed' };

export type AgentSessionAdminState = 'active' | 'expired' | 'revoked';

export interface AgentSessionAdminRecord extends AgentSession {
  last_seen_at?: string;
  state: AgentSessionAdminState;
}

export interface AgentSessionAdminList {
  list: AgentSessionAdminRecord[];
  total: number;
}

export interface AgentBusinessSessionRecord extends AgentSessionAdminRecord {
  authorization_id?: string;
}

export interface AgentBusinessSessionCursor {
  createdAt: string;
  sessionId: string;
}

export interface AgentBusinessSessionListInput {
  clientAppId: string;
  authorizationId?: string;
  onBehalfOf?: string;
  principalId?: string;
  /** Undefined leaves tenant unfiltered; an empty string selects no tenant. */
  tenant?: string;
  state?: AgentSessionAdminState | 'all';
  limit: number;
  cursor?: AgentBusinessSessionCursor;
}

export interface AgentBusinessSessionList {
  list: AgentBusinessSessionRecord[];
  nextCursor?: AgentBusinessSessionCursor;
}

export interface AgentSessionAdminSummary {
  total: number;
  active: number;
  expired: number;
  revoked: number;
}

function jsonObject<T extends object>(value: unknown): T {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as T;
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
  }
  throw new Error('Agent Auth 账本包含无效 JSON 对象');
}

function stringArray(value: unknown): string[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('Agent Auth 账本包含无效路由白名单');
  }
  return [...new Set(parsed)];
}

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function authorizationRow(row: any): AgentAuthorization {
  return {
    authorization_id: String(row.authorization_id),
    client_app_id: String(row.client_app_id),
    redirect_uri: String(row.redirect_uri),
    state: String(row.state_value),
    requested_routes: stringArray(row.requested_routes),
    device_label: String(row.device_label),
    code_challenge: String(row.code_challenge),
    status: String(row.status) as AgentAuthorizationStatus,
    ...(row.principal_json ? { principal: jsonObject<AgentBusinessPrincipal>(row.principal_json) } : {}),
    ...(row.on_behalf_of ? { on_behalf_of: String(row.on_behalf_of) } : {}),
    ...(row.allowed_routes ? { allowed_routes: stringArray(row.allowed_routes) } : {}),
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
    ...(row.code_expires_at ? { code_expires_at: iso(row.code_expires_at) } : {}),
    ...(row.session_id ? { session_id: String(row.session_id) } : {}),
  };
}

function sessionRow(row: any): AgentSession {
  return {
    session_id: String(row.session_id),
    client_app_id: String(row.client_app_id),
    device_label: String(row.device_label),
    principal: jsonObject<AgentBusinessPrincipal>(row.principal_json),
    on_behalf_of: String(row.on_behalf_of),
    allowed_routes: stringArray(row.allowed_routes),
    created_at: iso(row.created_at),
    access_expires_at: iso(row.access_expires_at),
    refresh_expires_at: iso(row.refresh_expires_at),
    ...(row.revoked_at ? { revoked_at: iso(row.revoked_at) } : {}),
  };
}

function sessionAdminState(row: any, now: Date): AgentSessionAdminState {
  if (row.revoked_at) return 'revoked';
  return new Date(row.refresh_expires_at).getTime() <= now.getTime() ? 'expired' : 'active';
}

function sessionAdminRow(row: any, now: Date): AgentSessionAdminRecord {
  return {
    ...sessionRow(row),
    ...(row.last_seen_at ? { last_seen_at: iso(row.last_seen_at) } : {}),
    state: sessionAdminState(row, now),
  };
}

function businessSessionRow(row: any, now: Date): AgentBusinessSessionRecord {
  const principal = jsonObject<Record<string, unknown>>(row.principal_json);
  if (typeof principal.id !== 'string' || !Array.isArray(principal.roles) ||
    !principal.roles.every((role) => typeof role === 'string')) throw new Error('Business Session principal is invalid.');
  return {
    ...sessionAdminRow(row, now),
    principal: {
      id: principal.id, roles: [...principal.roles] as string[],
      ...(typeof principal.tenant === 'string' ? { tenant: principal.tenant } : {}),
      ...(typeof principal.audience === 'string' ? { audience: principal.audience } : {}),
      ...(typeof principal.channel === 'string' ? { channel: principal.channel } : {}),
    },
    ...(row.authorization_id ? { authorization_id: String(row.authorization_id) } : {}),
  };
}

// Correlated aggregation preserves one row per Session, even if old/corrupt
// authorization data contains duplicate links. Ambiguous links are not guessed.
const BUSINESS_SESSION_COLUMNS = 's.session_id,s.client_app_id,s.device_label,s.principal_json,s.on_behalf_of,s.allowed_routes,' +
  's.access_expires_at,s.refresh_expires_at,s.created_at,s.updated_at,s.last_seen_at,s.revoked_at,' +
  "DATE_FORMAT(s.created_at,'%Y-%m-%dT%H:%i:%s.000Z') AS cursor_created_at," +
  '(SELECT CASE WHEN COUNT(*)=1 THEN MIN(a.authorization_id) ELSE NULL END FROM bz_agent_authorizations a ' +
  "WHERE a.session_id=s.session_id AND a.client_app_id=s.client_app_id AND a.status='consumed') AS authorization_id";

async function rollback(connection: PoolConnection): Promise<void> {
  await connection.rollback().catch(() => undefined);
}

/** MySQL-backed Agent Auth ledger. It only accepts token/code hashes. */
export class AgentAuthRepository {
  constructor(private readonly poolOf: () => Pool) {}

  private get pool(): Pool { return this.poolOf(); }

  async createAuthorization(input: {
    authorizationId: string;
    clientAppId: string;
    redirectUri: string;
    state: string;
    requestedRoutes: string[];
    deviceLabel: string;
    codeChallenge: string;
    expiresAt: string;
  }): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_agent_authorizations (authorization_id,client_app_id,redirect_uri,state_value,requested_routes,device_label,code_challenge,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,\'pending\',?,?)',
      [input.authorizationId, input.clientAppId, input.redirectUri, input.state, JSON.stringify(input.requestedRoutes), input.deviceLabel,
       input.codeChallenge, dt(), dtIso(input.expiresAt)],
    );
  }

  async getAuthorization(authorizationId: string): Promise<AgentAuthorization | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_agent_authorizations WHERE authorization_id=? LIMIT 1', [authorizationId]);
    return (rows as any[])[0] ? authorizationRow((rows as any[])[0]) : null;
  }

  async approveAuthorization(input: {
    authorizationId: string;
    clientAppId: string;
    principal: AgentBusinessPrincipal;
    onBehalfOf: string;
    allowedRoutes: string[];
    codeHash: string;
    codeExpiresAt: string;
  }): Promise<AuthorizationMutationResult> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query('SELECT * FROM bz_agent_authorizations WHERE authorization_id=? FOR UPDATE', [input.authorizationId]);
      const row = (rows as any[])[0];
      if (!row) { await rollback(connection); return { ok: false, reason: 'not_found' }; }
      if (String(row.client_app_id) !== input.clientAppId) { await rollback(connection); return { ok: false, reason: 'wrong_client' }; }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await connection.query('UPDATE bz_agent_authorizations SET status=\'expired\' WHERE authorization_id=? AND status=\'pending\'', [input.authorizationId]);
        await connection.commit();
        return { ok: false, reason: 'expired' };
      }
      if (String(row.status) !== 'pending') { await rollback(connection); return { ok: false, reason: 'invalid_state' }; }
      const [result] = await connection.query<ResultSetHeader>(
        'UPDATE bz_agent_authorizations SET status=\'approved\',principal_json=?,on_behalf_of=?,allowed_routes=?,code_hash=?,code_expires_at=?,approved_at=? WHERE authorization_id=? AND status=\'pending\'',
        [JSON.stringify(input.principal), input.onBehalfOf, JSON.stringify(input.allowedRoutes), input.codeHash, dtIso(input.codeExpiresAt), dt(), input.authorizationId],
      );
      if (result.affectedRows !== 1) { await rollback(connection); return { ok: false, reason: 'invalid_state' }; }
      const [updated] = await connection.query('SELECT * FROM bz_agent_authorizations WHERE authorization_id=? LIMIT 1', [input.authorizationId]);
      await connection.commit();
      return { ok: true, authorization: authorizationRow((updated as any[])[0]) };
    } catch (error) {
      await rollback(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async denyAuthorization(input: { authorizationId: string; clientAppId: string }): Promise<AuthorizationMutationResult> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query('SELECT * FROM bz_agent_authorizations WHERE authorization_id=? FOR UPDATE', [input.authorizationId]);
      const row = (rows as any[])[0];
      if (!row) { await rollback(connection); return { ok: false, reason: 'not_found' }; }
      if (String(row.client_app_id) !== input.clientAppId) { await rollback(connection); return { ok: false, reason: 'wrong_client' }; }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await connection.query('UPDATE bz_agent_authorizations SET status=\'expired\' WHERE authorization_id=? AND status=\'pending\'', [input.authorizationId]);
        await connection.commit();
        return { ok: false, reason: 'expired' };
      }
      if (String(row.status) !== 'pending') { await rollback(connection); return { ok: false, reason: 'invalid_state' }; }
      await connection.query('UPDATE bz_agent_authorizations SET status=\'denied\' WHERE authorization_id=? AND status=\'pending\'', [input.authorizationId]);
      const [updated] = await connection.query('SELECT * FROM bz_agent_authorizations WHERE authorization_id=? LIMIT 1', [input.authorizationId]);
      await connection.commit();
      return { ok: true, authorization: authorizationRow((updated as any[])[0]) };
    } catch (error) {
      await rollback(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  /** Competes with code exchange on the same authorization row, before any Session mutation. */
  async revokeAuthorization(input: { authorizationId: string; clientAppId: string }): Promise<AuthorizationRevocationResult> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query('SELECT * FROM bz_agent_authorizations WHERE authorization_id=? FOR UPDATE', [input.authorizationId]);
      const row = (rows as any[])[0];
      if (!row) { await rollback(connection); return { ok: false, reason: 'not_found' }; }
      if (String(row.client_app_id) !== input.clientAppId) { await rollback(connection); return { ok: false, reason: 'wrong_client' }; }
      let sessionId: string | undefined;
      if (row.status === 'consumed') {
        if (!row.session_id) { await rollback(connection); return { ok: false, reason: 'not_found' }; }
        const [sessions] = await connection.query('SELECT session_id,client_app_id FROM bz_agent_sessions WHERE session_id=? LIMIT 1 FOR UPDATE', [row.session_id]);
        const session = (sessions as any[])[0];
        if (!session) { await rollback(connection); return { ok: false, reason: 'not_found' }; }
        if (String(session.client_app_id) !== input.clientAppId) { await rollback(connection); return { ok: false, reason: 'wrong_client' }; }
        sessionId = String(session.session_id);
        const stamp = dt();
        await connection.query('UPDATE bz_agent_sessions SET revoked_at=COALESCE(revoked_at,?),updated_at=? WHERE session_id=?', [stamp, stamp, sessionId]);
        await connection.query('UPDATE bz_agent_refresh_tokens SET status=\'revoked\',used_at=COALESCE(used_at,?) WHERE session_id=? AND status=\'active\'', [stamp, sessionId]);
      } else if (row.status === 'pending' || row.status === 'approved') {
        await connection.query("UPDATE bz_agent_authorizations SET status='revoked',code_hash=NULL,code_expires_at=NULL WHERE authorization_id=?", [input.authorizationId]);
      } else if (!['revoked', 'denied', 'expired'].includes(String(row.status))) {
        throw new Error('Agent authorization lifecycle state is invalid.');
      }
      const [updated] = await connection.query('SELECT * FROM bz_agent_authorizations WHERE authorization_id=? LIMIT 1', [input.authorizationId]);
      const authorization = authorizationRow((updated as any[])[0]);
      await connection.commit();
      return { ok: true, authorization, ...(sessionId ? { sessionId } : {}) };
    } catch (error) {
      await rollback(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async exchangeAuthorizationCode(input: {
    codeHash: string;
    clientAppId: string;
    redirectUri: string;
    codeChallenge: string;
    sessionId: string;
    accessTokenHash: string;
    refreshTokenHash: string;
    accessExpiresAt: string;
    refreshExpiresAt: string;
  }): Promise<AuthorizationExchangeResult> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query('SELECT * FROM bz_agent_authorizations WHERE code_hash=? FOR UPDATE', [input.codeHash]);
      const row = (rows as any[])[0];
      if (!row || String(row.status) !== 'approved' || String(row.client_app_id) !== input.clientAppId ||
          String(row.redirect_uri) !== input.redirectUri || String(row.code_challenge) !== input.codeChallenge ||
          !row.code_expires_at || new Date(row.code_expires_at).getTime() <= Date.now() || !row.principal_json || !row.on_behalf_of || !row.allowed_routes) {
        await rollback(connection);
        return { ok: false, reason: 'invalid_grant' };
      }
      const createdAt = dt();
      await connection.query(
        'INSERT INTO bz_agent_sessions (session_id,client_app_id,device_label,principal_json,on_behalf_of,allowed_routes,access_token_hash,access_expires_at,refresh_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [input.sessionId, input.clientAppId, row.device_label, typeof row.principal_json === 'string' ? row.principal_json : JSON.stringify(row.principal_json),
         row.on_behalf_of, typeof row.allowed_routes === 'string' ? row.allowed_routes : JSON.stringify(row.allowed_routes), input.accessTokenHash,
         dtIso(input.accessExpiresAt), dtIso(input.refreshExpiresAt), createdAt, createdAt],
      );
      await connection.query(
        'INSERT INTO bz_agent_refresh_tokens (token_hash,session_id,status,created_at,expires_at) VALUES (?,? ,\'active\',?,?)',
        [input.refreshTokenHash, input.sessionId, createdAt, dtIso(input.refreshExpiresAt)],
      );
      const [updated] = await connection.query<ResultSetHeader>(
        'UPDATE bz_agent_authorizations SET status=\'consumed\',session_id=?,consumed_at=? WHERE authorization_id=? AND status=\'approved\'',
        [input.sessionId, createdAt, row.authorization_id],
      );
      if (updated.affectedRows !== 1) { await rollback(connection); return { ok: false, reason: 'invalid_grant' }; }
      const [sessionRows] = await connection.query('SELECT * FROM bz_agent_sessions WHERE session_id=? LIMIT 1', [input.sessionId]);
      await connection.commit();
      return { ok: true, session: sessionRow((sessionRows as any[])[0]) };
    } catch (error) {
      await rollback(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async getSessionByAccessHash(accessTokenHash: string): Promise<AgentSession | null> {
    const [rows] = await this.pool.query(
      'SELECT * FROM bz_agent_sessions WHERE access_token_hash=? AND revoked_at IS NULL AND access_expires_at>=? AND refresh_expires_at>=? LIMIT 1',
      [accessTokenHash, dt(), dt()],
    );
    const row = (rows as any[])[0];
    if (!row) return null;
    void this.pool.query('UPDATE bz_agent_sessions SET last_seen_at=? WHERE session_id=?', [dt(), row.session_id]).catch(() => undefined);
    return sessionRow(row);
  }

  /** Client Token callers supply their authenticated App, never a model-selected scope. */
  async getBusinessSession(clientAppId: string, sessionId: string): Promise<AgentBusinessSessionRecord | null> {
    if (!clientAppId) throw new Error('Business Session queries require an authenticated Client App.');
    const [rows] = await this.pool.query(`SELECT ${BUSINESS_SESSION_COLUMNS} FROM bz_agent_sessions s WHERE s.client_app_id=? AND s.session_id=? LIMIT 1`, [clientAppId, sessionId]);
    const row = (rows as any[])[0];
    return row && row.client_app_id === clientAppId && row.session_id === sessionId ? businessSessionRow(row, new Date()) : null;
  }

  async listBusinessSessions(input: AgentBusinessSessionListInput): Promise<AgentBusinessSessionList> {
    if (!input.clientAppId) throw new Error('Business Session queries require an authenticated Client App.');
    const now = new Date();
    const limit = Math.min(Math.max(Math.floor(Number(input.limit) || 50), 1), 100);
    const where = ['s.client_app_id=?'];
    const params: unknown[] = [input.clientAppId];
    if (input.authorizationId !== undefined) {
      where.push("EXISTS (SELECT 1 FROM bz_agent_authorizations matched WHERE matched.authorization_id=? AND matched.client_app_id=s.client_app_id AND matched.session_id=s.session_id AND matched.status='consumed')");
      params.push(input.authorizationId);
    }
    if (input.onBehalfOf !== undefined) { where.push('BINARY s.on_behalf_of=BINARY ?'); params.push(input.onBehalfOf); }
    if (input.principalId !== undefined) {
      where.push("BINARY JSON_UNQUOTE(JSON_EXTRACT(s.principal_json,'$.id'))=BINARY ?"); params.push(input.principalId);
    }
    if (input.tenant !== undefined) {
      where.push("BINARY (CASE WHEN JSON_EXTRACT(s.principal_json,'$.tenant') IS NULL OR JSON_TYPE(JSON_EXTRACT(s.principal_json,'$.tenant'))='NULL' THEN '' ELSE JSON_UNQUOTE(JSON_EXTRACT(s.principal_json,'$.tenant')) END)=BINARY ?");
      params.push(input.tenant);
    }
    if (input.state === 'active') { where.push('s.revoked_at IS NULL AND s.refresh_expires_at>?'); params.push(dtIso(now.toISOString())); }
    else if (input.state === 'expired') { where.push('s.revoked_at IS NULL AND s.refresh_expires_at<=?'); params.push(dtIso(now.toISOString())); }
    else if (input.state === 'revoked') where.push('s.revoked_at IS NOT NULL');
    if (input.cursor) {
      where.push('(s.created_at<? OR (s.created_at=? AND s.session_id<?))');
      params.push(dtIso(input.cursor.createdAt), dtIso(input.cursor.createdAt), input.cursor.sessionId);
    }
    const [rows] = await this.pool.query(`SELECT ${BUSINESS_SESSION_COLUMNS} FROM bz_agent_sessions s WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC,s.session_id DESC LIMIT ?`, [...params, limit + 1]);
    const records = rows as any[];
    if (records.some((row) => row.client_app_id !== input.clientAppId)) throw new Error('Business Session ownership mismatch.');
    const selected = records.slice(0, limit);
    const last = selected.at(-1);
    if (records.length > limit && last && typeof last.cursor_created_at !== 'string') throw new Error('Business Session cursor timestamp is invalid.');
    // Use a DB-formatted UTC literal for the cursor rather than reparsing a
    // driver's local-time Date; the cursor must round-trip the stored DATETIME.
    return { list: selected.map((row) => businessSessionRow(row, now)),
      ...(records.length > limit && last ? { nextCursor: { createdAt: String(last.cursor_created_at), sessionId: String(last.session_id) } } : {}) };
  }

  /** Admin-only projection. Token hashes and refresh-token rows never leave the repository. */
  async listSessionsForAdmin(input: {
    clientAppId?: string;
    state?: AgentSessionAdminState | 'all';
    limit?: number;
    offset?: number;
    now?: Date;
  } = {}): Promise<AgentSessionAdminList> {
    const now = input.now ?? new Date();
    const limit = Math.min(Math.max(Math.round(Number(input.limit) || 50), 1), 200);
    const offset = Math.max(Math.round(Number(input.offset) || 0), 0);
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.clientAppId) {
      where.push('client_app_id=?');
      params.push(input.clientAppId);
    }
    if (input.state === 'active') {
      where.push('revoked_at IS NULL AND refresh_expires_at>?');
      params.push(dtIso(now.toISOString()));
    } else if (input.state === 'expired') {
      where.push('revoked_at IS NULL AND refresh_expires_at<=?');
      params.push(dtIso(now.toISOString()));
    } else if (input.state === 'revoked') {
      where.push('revoked_at IS NOT NULL');
    }
    const predicate = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const [countRows] = await this.pool.query(`SELECT COUNT(*) AS total FROM bz_agent_sessions${predicate}`, params);
    const [rows] = await this.pool.query(
      `SELECT session_id,client_app_id,device_label,principal_json,on_behalf_of,allowed_routes,access_expires_at,refresh_expires_at,created_at,updated_at,last_seen_at,revoked_at FROM bz_agent_sessions${predicate} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return {
      list: (rows as any[]).map((row) => sessionAdminRow(row, now)),
      total: Number((countRows as any[])[0]?.total ?? 0),
    };
  }

  async getSessionForAdmin(sessionId: string, now = new Date()): Promise<AgentSessionAdminRecord | null> {
    const [rows] = await this.pool.query(
      'SELECT session_id,client_app_id,device_label,principal_json,on_behalf_of,allowed_routes,access_expires_at,refresh_expires_at,created_at,updated_at,last_seen_at,revoked_at FROM bz_agent_sessions WHERE session_id=? LIMIT 1',
      [sessionId],
    );
    return (rows as any[])[0] ? sessionAdminRow((rows as any[])[0], now) : null;
  }

  async sessionSummaryForAdmin(now = new Date()): Promise<AgentSessionAdminSummary> {
    const stamp = dtIso(now.toISOString());
    const [rows] = await this.pool.query(
      'SELECT COUNT(*) AS total,' +
      ' SUM(CASE WHEN revoked_at IS NULL AND refresh_expires_at>? THEN 1 ELSE 0 END) AS active,' +
      ' SUM(CASE WHEN revoked_at IS NULL AND refresh_expires_at<=? THEN 1 ELSE 0 END) AS expired,' +
      ' SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked' +
      ' FROM bz_agent_sessions',
      [stamp, stamp],
    );
    const row = (rows as any[])[0] ?? {};
    return {
      total: Number(row.total ?? 0),
      active: Number(row.active ?? 0),
      expired: Number(row.expired ?? 0),
      revoked: Number(row.revoked ?? 0),
    };
  }

  async rotateRefreshToken(input: {
    refreshTokenHash: string;
    clientAppId: string;
    accessTokenHash: string;
    nextRefreshTokenHash: string;
    accessExpiresAt: string;
  }): Promise<RefreshRotationResult> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // Locate without locking, then lock Session before refresh rows just like
      // revocation. Revalidate the token's original owner after both locks.
      const [located] = await connection.query('SELECT session_id FROM bz_agent_refresh_tokens WHERE token_hash=? LIMIT 1', [input.refreshTokenHash]);
      const sessionId = (located as any[])[0]?.session_id;
      if (!sessionId) { await rollback(connection); return { ok: false, reason: 'invalid_grant' }; }
      const [sessionRows] = await connection.query('SELECT * FROM bz_agent_sessions WHERE session_id=? FOR UPDATE', [sessionId]);
      const session = (sessionRows as any[])[0];
      if (!session || String(session.client_app_id) !== input.clientAppId) { await rollback(connection); return { ok: false, reason: 'invalid_grant' }; }
      const [tokenRows] = await connection.query('SELECT * FROM bz_agent_refresh_tokens WHERE token_hash=? FOR UPDATE', [input.refreshTokenHash]);
      const tokenRow = (tokenRows as any[])[0];
      if (!tokenRow || String(tokenRow.session_id) !== String(sessionId)) { await rollback(connection); return { ok: false, reason: 'invalid_grant' }; }
      if (String(tokenRow.status) !== 'active') {
        const stamp = dt();
        await connection.query('UPDATE bz_agent_sessions SET revoked_at=COALESCE(revoked_at,?),updated_at=? WHERE session_id=?', [stamp, stamp, session.session_id]);
        await connection.query('UPDATE bz_agent_refresh_tokens SET status=CASE WHEN token_hash=? THEN \'replayed\' ELSE \'revoked\' END,used_at=COALESCE(used_at,?) WHERE session_id=? AND status IN (\'active\',\'used\')', [input.refreshTokenHash, stamp, session.session_id]);
        await connection.commit();
        return { ok: false, reason: 'replayed' };
      }
      if (session.revoked_at || new Date(tokenRow.expires_at).getTime() <= Date.now() || new Date(session.refresh_expires_at).getTime() <= Date.now()) {
        await rollback(connection);
        return { ok: false, reason: 'invalid_grant' };
      }
      const stamp = dt();
      await connection.query('UPDATE bz_agent_refresh_tokens SET status=\'used\',used_at=? WHERE token_hash=? AND status=\'active\'', [stamp, input.refreshTokenHash]);
      await connection.query(
        'INSERT INTO bz_agent_refresh_tokens (token_hash,session_id,status,created_at,expires_at) VALUES (?,? ,\'active\',?,?)',
        [input.nextRefreshTokenHash, session.session_id, stamp, session.refresh_expires_at],
      );
      await connection.query(
        'UPDATE bz_agent_sessions SET access_token_hash=?,access_expires_at=?,updated_at=? WHERE session_id=? AND revoked_at IS NULL',
        [input.accessTokenHash, dtIso(input.accessExpiresAt), stamp, session.session_id],
      );
      const [updated] = await connection.query('SELECT * FROM bz_agent_sessions WHERE session_id=? LIMIT 1', [session.session_id]);
      await connection.commit();
      return { ok: true, session: sessionRow((updated as any[])[0]) };
    } catch (error) {
      await rollback(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async revokeByAccessHash(accessTokenHash: string): Promise<boolean> {
    const stamp = dt();
    const [result] = await this.pool.query<ResultSetHeader>(
      'UPDATE bz_agent_sessions SET revoked_at=COALESCE(revoked_at,?),updated_at=? WHERE access_token_hash=?',
      [stamp, stamp, accessTokenHash],
    );
    if (result.affectedRows > 0) {
      await this.pool.query(
        'UPDATE bz_agent_refresh_tokens r JOIN bz_agent_sessions s ON s.session_id=r.session_id SET r.status=\'revoked\',r.used_at=COALESCE(r.used_at,?) WHERE s.access_token_hash=? AND r.status=\'active\'',
        [stamp, accessTokenHash],
      );
    }
    return result.affectedRows > 0;
  }

  async revokeByRefreshHash(clientAppId: string, refreshTokenHash: string): Promise<boolean> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [located] = await connection.query('SELECT session_id FROM bz_agent_refresh_tokens WHERE token_hash=? LIMIT 1', [refreshTokenHash]);
      const sessionId = (located as any[])[0]?.session_id;
      if (!sessionId) { await rollback(connection); return false; }
      const [sessions] = await connection.query('SELECT session_id,client_app_id FROM bz_agent_sessions WHERE session_id=? LIMIT 1 FOR UPDATE', [sessionId]);
      const session = (sessions as any[])[0];
      if (!session || String(session.client_app_id) !== clientAppId) { await rollback(connection); return false; }
      const [tokens] = await connection.query('SELECT * FROM bz_agent_refresh_tokens WHERE token_hash=? FOR UPDATE', [refreshTokenHash]);
      if (!(tokens as any[])[0] || String((tokens as any[])[0].session_id) !== String(sessionId)) { await rollback(connection); return false; }
      const stamp = dt();
      await connection.query('UPDATE bz_agent_sessions SET revoked_at=COALESCE(revoked_at,?),updated_at=? WHERE session_id=?', [stamp, stamp, sessionId]);
      await connection.query('UPDATE bz_agent_refresh_tokens SET status=\'revoked\',used_at=COALESCE(used_at,?) WHERE session_id=? AND status=\'active\'', [stamp, sessionId]);
      await connection.commit();
      return true;
    } catch (error) {
      await rollback(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async revokeSessionForClient(clientAppId: string, sessionId: string): Promise<boolean> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(
        'SELECT session_id FROM bz_agent_sessions WHERE session_id=? AND client_app_id=? LIMIT 1 FOR UPDATE',
        [sessionId, clientAppId],
      );
      if (!(rows as any[])[0]) { await rollback(connection); return false; }
      const stamp = dt();
      await connection.query('UPDATE bz_agent_sessions SET revoked_at=COALESCE(revoked_at,?),updated_at=? WHERE session_id=?', [stamp, stamp, sessionId]);
      await connection.query('UPDATE bz_agent_refresh_tokens SET status=\'revoked\',used_at=COALESCE(used_at,?) WHERE session_id=? AND status=\'active\'', [stamp, sessionId]);
      await connection.commit();
      return true;
    } catch (error) {
      await rollback(connection);
      throw error;
    } finally {
      connection.release();
    }
  }
}

type AgentAuthLifecycleMethod = 'getBusinessSession' | 'listBusinessSessions' | 'revokeAuthorization';
export type AgentAuthRepositoryContract = Omit<Pick<AgentAuthRepository, keyof AgentAuthRepository>, AgentAuthLifecycleMethod> &
  Partial<Pick<AgentAuthRepository, AgentAuthLifecycleMethod>>;
