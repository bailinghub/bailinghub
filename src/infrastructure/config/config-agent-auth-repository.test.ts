import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { AgentAuthRepository } from './config-agent-auth-repository';

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: '123e4567-e89b-42d3-a456-426614174000',
    client_app_id: 'digital-cloud',
    device_label: 'Mac mini',
    principal_json: JSON.stringify({ id: 'user-7', tenant: 'tenant-2', roles: ['manager'] }),
    on_behalf_of: 'tenant-2:user-7',
    allowed_routes: JSON.stringify(['orders']),
    access_token_hash: 'a'.repeat(64),
    access_expires_at: '2099-01-01 00:15:00',
    refresh_expires_at: '2099-01-30 00:00:00',
    created_at: '2099-01-01 00:00:00',
    updated_at: '2099-01-01 00:00:00',
    last_seen_at: null,
    revoked_at: null,
    ...overrides,
  };
}

test('AgentAuthRepository refresh rotation keeps the original absolute refresh expiry', async () => {
  const originalRefreshExpiry = '2099-01-30 00:00:00';
  let insertedRefreshExpiry: unknown;
  let updatedSessionParams: unknown[] = [];
  const row = sessionRow({ refresh_expires_at: originalRefreshExpiry });
  const connection = {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
    async query(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT * FROM bz_agent_refresh_tokens')) {
        return [[{ token_hash: 'r'.repeat(64), session_id: row.session_id, status: 'active', expires_at: originalRefreshExpiry }], []];
      }
      if (sql.startsWith('SELECT * FROM bz_agent_sessions') && sql.includes('FOR UPDATE')) return [[row], []];
      if (sql.startsWith('UPDATE bz_agent_refresh_tokens SET status=\'used\'')) return [{ affectedRows: 1 }, []];
      if (sql.startsWith('INSERT INTO bz_agent_refresh_tokens')) {
        insertedRefreshExpiry = params[3];
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('UPDATE bz_agent_sessions SET access_token_hash=')) {
        updatedSessionParams = params;
        row.access_token_hash = params[0];
        row.access_expires_at = params[1];
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('SELECT * FROM bz_agent_sessions')) return [[row], []];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const pool = { getConnection: async () => connection } as unknown as Pool;
  const repo = new AgentAuthRepository(() => pool);
  const result = await repo.rotateRefreshToken({
    refreshTokenHash: 'r'.repeat(64),
    clientAppId: 'digital-cloud',
    accessTokenHash: 'b'.repeat(64),
    nextRefreshTokenHash: 'n'.repeat(64),
    accessExpiresAt: '2099-01-01T00:30:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(insertedRefreshExpiry, originalRefreshExpiry);
  assert.equal(updatedSessionParams.length, 4);
  assert.equal(updatedSessionParams.includes(originalRefreshExpiry), false);
  if (result.ok) assert.equal(Date.parse(result.session.refresh_expires_at), new Date(originalRefreshExpiry).getTime());
});

test('AgentAuthRepository refresh replay revokes the whole session fail closed', async () => {
  let sessionRevoked = false;
  let refreshFamilyRevoked = false;
  const row = sessionRow();
  const connection = {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
    async query(sql: string) {
      if (sql.startsWith('SELECT * FROM bz_agent_refresh_tokens')) {
        return [[{ token_hash: 'r'.repeat(64), session_id: row.session_id, status: 'used', expires_at: row.refresh_expires_at }], []];
      }
      if (sql.startsWith('SELECT * FROM bz_agent_sessions')) return [[row], []];
      if (sql.startsWith('UPDATE bz_agent_sessions SET revoked_at=')) { sessionRevoked = true; return [{ affectedRows: 1 }, []]; }
      if (sql.startsWith('UPDATE bz_agent_refresh_tokens SET status=CASE')) { refreshFamilyRevoked = true; return [{ affectedRows: 2 }, []]; }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const pool = { getConnection: async () => connection } as unknown as Pool;
  const repo = new AgentAuthRepository(() => pool);
  const result = await repo.rotateRefreshToken({
    refreshTokenHash: 'r'.repeat(64),
    clientAppId: 'digital-cloud',
    accessTokenHash: 'b'.repeat(64),
    nextRefreshTokenHash: 'n'.repeat(64),
    accessExpiresAt: '2099-01-01T00:30:00.000Z',
  });

  assert.deepEqual(result, { ok: false, reason: 'replayed' });
  assert.equal(sessionRevoked, true);
  assert.equal(refreshFamilyRevoked, true);
});

test('AgentAuthRepository rejects an approved authorization after its short code expiry', async () => {
  let insertedSession = false;
  const connection = {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
    async query(sql: string) {
      if (sql.startsWith('SELECT * FROM bz_agent_authorizations')) {
        return [[{
          authorization_id: '123e4567-e89b-42d3-a456-426614174000',
          client_app_id: 'digital-cloud',
          redirect_uri: 'http://127.0.0.1:43123/callback',
          code_challenge: 'c'.repeat(43),
          code_expires_at: '2000-01-01 00:00:00',
          status: 'approved',
          principal_json: JSON.stringify({ id: 'user-7', roles: [] }),
          on_behalf_of: 'tenant-2:user-7',
          allowed_routes: JSON.stringify(['orders']),
        }], []];
      }
      if (sql.startsWith('INSERT INTO bz_agent_sessions')) { insertedSession = true; return [{ affectedRows: 1 }, []]; }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const pool = { getConnection: async () => connection } as unknown as Pool;
  const repo = new AgentAuthRepository(() => pool);
  const result = await repo.exchangeAuthorizationCode({
    codeHash: 'c'.repeat(64),
    clientAppId: 'digital-cloud',
    redirectUri: 'http://127.0.0.1:43123/callback',
    codeChallenge: 'c'.repeat(43),
    sessionId: '223e4567-e89b-42d3-a456-426614174000',
    accessTokenHash: 'a'.repeat(64),
    refreshTokenHash: 'r'.repeat(64),
    accessExpiresAt: '2099-01-01T00:15:00.000Z',
    refreshExpiresAt: '2099-01-30T00:00:00.000Z',
  });

  assert.deepEqual(result, { ok: false, reason: 'invalid_grant' });
  assert.equal(insertedSession, false);
});
