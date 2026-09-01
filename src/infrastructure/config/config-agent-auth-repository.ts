import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { dt, dtIso } from '../../core/config/config-codec';
import type { AgentBusinessPrincipal, AgentSession } from '../../core/contracts/types';

export type AgentAuthorizationStatus = 'pending' | 'approved' | 'consumed' | 'denied' | 'expired';

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
}

export type AuthorizationMutationResult =
  | { ok: true; authorization: AgentAuthorization }
  | { ok: false; reason: 'not_found' | 'wrong_client' | 'expired' | 'invalid_state' };

export type AuthorizationExchangeResult =
  | { ok: true; session: AgentSession }
  | { ok: false; reason: 'invalid_grant' };

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
      const [tokenRows] = await connection.query('SELECT * FROM bz_agent_refresh_tokens WHERE token_hash=? FOR UPDATE', [input.refreshTokenHash]);
      const tokenRow = (tokenRows as any[])[0];
      if (!tokenRow) { await rollback(connection); return { ok: false, reason: 'invalid_grant' }; }
      const [sessionRows] = await connection.query('SELECT * FROM bz_agent_sessions WHERE session_id=? FOR UPDATE', [tokenRow.session_id]);
      const session = (sessionRows as any[])[0];
      if (!session || String(session.client_app_id) !== input.clientAppId) { await rollback(connection); return { ok: false, reason: 'invalid_grant' }; }
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
      const [rows] = await connection.query(
        'SELECT s.session_id FROM bz_agent_refresh_tokens r JOIN bz_agent_sessions s ON s.session_id=r.session_id WHERE r.token_hash=? AND s.client_app_id=? LIMIT 1 FOR UPDATE',
        [refreshTokenHash, clientAppId],
      );
      const sessionId = (rows as any[])[0]?.session_id;
      if (!sessionId) { await rollback(connection); return false; }
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

export type AgentAuthRepositoryContract = Pick<AgentAuthRepository, keyof AgentAuthRepository>;
