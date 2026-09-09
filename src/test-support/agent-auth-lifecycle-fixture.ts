import assert from 'node:assert/strict';
import type { Pool } from 'mysql2/promise';
import { AgentAuthRepository } from '../infrastructure/config/config-agent-auth-repository';

type Row = Record<string, any>;
type Table = 'authorization' | 'session' | 'token';
type Transaction = { id: number; writes: Map<string, Row>; locks: Set<string> };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export const AUTH = '11111111-1111-4111-8111-111111111111';
export const SESSION = '22222222-2222-4222-8222-222222222222';
export const OTHER_SESSION = '33333333-3333-4333-8333-333333333333';
export const APP = 'synthetic-shop';
export const FUTURE = '2099-01-01T00:00:00.000Z';
export const REDIRECT = 'http://127.0.0.1:43111/callback';

/**
 * Executes the real repository SQL against a narrow transactional test double.
 * Writes are private until commit; row locks persist through commit/rollback.
 * Locking reads re-read committed rows after waiting. Unknown SQL fails closed.
 * This validates repository scheduling and rollback, not MySQL/InnoDB semantics.
 */
export class LedgerFixture {
  readonly rows: Record<Table, Map<string, Row>> = {
    authorization: new Map(), session: new Map(), token: new Map(),
  };
  private sequence = 0;
  private owners = new Map<string, number>();
  private changed = new Map<string, ReturnType<typeof deferred>[]>();
  private blocked = new Map<string, ReturnType<typeof deferred>>();
  private pauseLocks = new Map<string, { arrived: ReturnType<typeof deferred>; resume: ReturnType<typeof deferred> }>();
  private failure?: { fragment: string; error: Error };
  private failCommit = false;
  readonly pool: Pool;
  readonly repository: AgentAuthRepository;

  constructor() {
    this.rows.authorization.set(AUTH, {
      authorization_id: AUTH, client_app_id: APP, redirect_uri: REDIRECT,
      state_value: 'synthetic-state', requested_routes: '["shop"]', device_label: 'Synthetic device',
      code_challenge: 'synthetic-challenge', status: 'pending', created_at: '2026-01-01 00:00:00',
      expires_at: FUTURE, principal_json: null, allowed_routes: null, on_behalf_of: null,
      code_hash: null, code_expires_at: null, session_id: null,
    });
    this.pool = {
      getConnection: async () => {
        const tx: Transaction = { id: ++this.sequence, writes: new Map(), locks: new Set() };
        return {
          beginTransaction: async () => {},
          query: async (sql: string, params: unknown[] = []) => this.query(tx, sql, params),
          commit: async () => {
            if (this.failCommit) { this.failCommit = false; throw new Error('synthetic commit unavailable'); }
            for (const [key, row] of tx.writes) {
              const colon = key.indexOf(':');
              this.rows[key.slice(0, colon) as Table].set(key.slice(colon + 1), structuredClone(row));
            }
            tx.writes.clear();
            this.unlock(tx);
          },
          rollback: async () => { tx.writes.clear(); this.unlock(tx); },
          release: () => { assert.equal(tx.locks.size, 0, 'connection must not release uncommitted locks'); },
        };
      },
      query: async (sql: string, params: unknown[] = []) => this.query(null, sql, params),
    } as unknown as Pool;
    this.repository = new AgentAuthRepository(() => this.pool);
  }

  private all(table: Table, tx: Transaction | null): Row[] {
    const rows = new Map(this.rows[table]);
    for (const [key, row] of tx?.writes ?? []) if (key.startsWith(`${table}:`)) rows.set(key.slice(table.length + 1), row);
    return [...rows.values()].map((row) => structuredClone(row));
  }

  private row(table: Table, id: string, tx: Transaction | null): Row | undefined {
    const value = tx?.writes.get(`${table}:${id}`) ?? this.rows[table].get(id);
    return value ? structuredClone(value) : undefined;
  }

  private async lock(tx: Transaction | null, key: string) {
    assert.ok(tx, 'mutations/locking reads require a transaction');
    while (this.owners.has(key) && this.owners.get(key) !== tx.id) {
      this.blocked.get(key)?.resolve();
      const wake = deferred();
      const waiters = this.changed.get(key) ?? [];
      waiters.push(wake);
      this.changed.set(key, waiters);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([wake.promise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`synthetic row-lock timeout: ${key}`)), 2000);
        })]);
      } finally { clearTimeout(timer); this.changed.set(key, (this.changed.get(key) ?? []).filter((item) => item !== wake)); }
    }
    this.owners.set(key, tx.id);
    tx.locks.add(key);
    const pause = this.pauseLocks.get(key);
    if (pause) {
      this.pauseLocks.delete(key);
      pause.arrived.resolve();
      await pause.resume.promise;
    }
  }

  private unlock(tx: Transaction) {
    for (const key of tx.locks) {
      this.owners.delete(key);
      for (const waiter of this.changed.get(key) ?? []) waiter.resolve();
    }
    tx.locks.clear();
  }

  holdNextLock(table: Table, id: string) {
    const pause = { arrived: deferred(), resume: deferred() };
    this.pauseLocks.set(`${table}:${id}`, pause);
    return { arrived: pause.arrived.promise, release: () => pause.resume.resolve() };
  }

  waitForBlocked(table: Table, id: string) {
    const blocked = deferred();
    this.blocked.set(`${table}:${id}`, blocked);
    return blocked.promise;
  }

  failNext(fragment: string) { this.failure = { fragment, error: new Error('synthetic storage unavailable') }; }
  failNextCommit() { this.failCommit = true; }

  private async save(tx: Transaction | null, table: Table, id: string, row: Row) {
    await this.lock(tx, `${table}:${id}`);
    tx!.writes.set(`${table}:${id}`, structuredClone(row));
  }

  private async query(tx: Transaction | null, originalSql: string, params: unknown[]): Promise<any[]> {
    const sql = originalSql.replace(/\s+/g, ' ').trim();
    const p = params as any[];
    if (this.failure && sql.includes(this.failure.fragment)) {
      const error = this.failure.error; this.failure = undefined; throw error;
    }
    if (sql.startsWith('INSERT INTO bz_agent_authorizations ')) {
      assert.equal(tx, null, 'authorization creation uses an autocommit insert');
      assert.equal(this.rows.authorization.has(p[0]), false, 'duplicate authorization');
      const names = ['authorization_id', 'client_app_id', 'redirect_uri', 'state_value', 'requested_routes', 'device_label', 'code_challenge', 'created_at', 'expires_at'];
      this.rows.authorization.set(p[0], { ...Object.fromEntries(names.map((name, i) => [name, p[i]])), status: 'pending',
        principal_json: null, allowed_routes: null, on_behalf_of: null, code_hash: null, code_expires_at: null, session_id: null });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT * FROM bz_agent_authorizations WHERE')) {
      const byCode = sql.includes('WHERE code_hash=?');
      const locate = () => byCode ? this.all('authorization', tx).find((row) => row.code_hash === p[0]) : this.row('authorization', p[0], tx);
      const initial = locate();
      if (sql.endsWith('FOR UPDATE') && initial) await this.lock(tx, `authorization:${initial.authorization_id}`);
      const row = locate();
      return [row ? [row] : []];
    }
    if (sql.startsWith('SELECT ') && sql.includes('FROM bz_agent_sessions WHERE session_id=?')) {
      if (sql.endsWith('FOR UPDATE')) await this.lock(tx, `session:${p[0]}`);
      const row = this.row('session', p[0], tx);
      return [row && (!sql.includes('AND client_app_id=?') || row.client_app_id === p[1]) ? [row] : []];
    }
    if (sql.startsWith('SELECT ') && sql.includes('FROM bz_agent_refresh_tokens WHERE token_hash=?')) {
      if (sql.endsWith('FOR UPDATE')) await this.lock(tx, `token:${p[0]}`);
      const row = this.row('token', p[0], tx);
      return [row ? [row] : []];
    }
    if (sql.startsWith('SELECT * FROM bz_agent_sessions WHERE access_token_hash=?')) {
      return [this.all('session', tx).filter((row) => row.access_token_hash === p[0] && !row.revoked_at &&
        String(row.access_expires_at) >= p[1] && String(row.refresh_expires_at) >= p[2])];
    }
    if (sql.startsWith('UPDATE bz_agent_sessions SET last_seen_at=')) return [{ affectedRows: 1 }];
    if (sql.startsWith("UPDATE bz_agent_authorizations SET status='approved'")) {
      const row = this.row('authorization', p[6], tx);
      if (!row || row.status !== 'pending') return [{ affectedRows: 0 }];
      Object.assign(row, { status: 'approved', principal_json: p[0], on_behalf_of: p[1], allowed_routes: p[2], code_hash: p[3], code_expires_at: p[4], approved_at: p[5] });
      await this.save(tx, 'authorization', p[6], row);
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE bz_agent_authorizations SET status='revoked'")) {
      const row = this.row('authorization', p[0], tx)!;
      Object.assign(row, { status: 'revoked', code_hash: null, code_expires_at: null });
      await this.save(tx, 'authorization', p[0], row);
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE bz_agent_authorizations SET status='consumed'")) {
      const row = this.row('authorization', p[2], tx);
      if (!row || row.status !== 'approved') return [{ affectedRows: 0 }];
      Object.assign(row, { status: 'consumed', session_id: p[0], consumed_at: p[1] });
      await this.save(tx, 'authorization', p[2], row);
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('INSERT INTO bz_agent_sessions ')) {
      assert.equal(this.row('session', p[0], tx), undefined, 'duplicate session');
      const names = ['session_id', 'client_app_id', 'device_label', 'principal_json', 'on_behalf_of', 'allowed_routes', 'access_token_hash', 'access_expires_at', 'refresh_expires_at', 'created_at', 'updated_at'];
      await this.save(tx, 'session', p[0], { ...Object.fromEntries(names.map((name, i) => [name, p[i]])), revoked_at: null });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('INSERT INTO bz_agent_refresh_tokens ')) {
      assert.equal(this.row('token', p[0], tx), undefined, 'duplicate refresh token');
      await this.save(tx, 'token', p[0], { token_hash: p[0], session_id: p[1], status: 'active', created_at: p[2], expires_at: p[3], used_at: null });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE bz_agent_sessions SET revoked_at=')) {
      const row = this.row('session', p[2], tx)!;
      Object.assign(row, { revoked_at: row.revoked_at ?? p[0], updated_at: p[1] });
      await this.save(tx, 'session', p[2], row);
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE bz_agent_sessions SET access_token_hash=')) {
      const row = this.row('session', p[3], tx);
      if (!row || row.revoked_at) return [{ affectedRows: 0 }];
      Object.assign(row, { access_token_hash: p[0], access_expires_at: p[1], updated_at: p[2] });
      await this.save(tx, 'session', p[3], row);
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE bz_agent_refresh_tokens SET status='used'")) {
      const row = this.row('token', p[1], tx);
      if (!row || row.status !== 'active') return [{ affectedRows: 0 }];
      Object.assign(row, { status: 'used', used_at: p[0] });
      await this.save(tx, 'token', p[1], row);
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE bz_agent_refresh_tokens SET status='revoked'") || sql.startsWith('UPDATE bz_agent_refresh_tokens SET status=CASE')) {
      const replay = sql.includes('status=CASE');
      const sessionId = p[replay ? 2 : 1];
      let affectedRows = 0;
      for (const row of this.all('token', tx)) {
        if (row.session_id !== sessionId || !(replay ? ['active', 'used'] : ['active']).includes(row.status)) continue;
        await this.lock(tx, `token:${row.token_hash}`);
        const current = this.row('token', row.token_hash, tx)!;
        current.status = replay && row.token_hash === p[0] ? 'replayed' : 'revoked';
        current.used_at ??= p[replay ? 1 : 0];
        await this.save(tx, 'token', row.token_hash, current);
        affectedRows++;
      }
      return [{ affectedRows }];
    }
    throw new Error(`Unsupported lifecycle fixture SQL: ${sql}`);
  }

  async approve() {
    const result = await this.repository.approveAuthorization({ authorizationId: AUTH, clientAppId: APP,
      principal: { id: 'synthetic-owner', tenant: 'store-a', roles: ['manager'] }, onBehalfOf: 'store-a',
      allowedRoutes: ['shop'], codeHash: 'synthetic-code-hash', codeExpiresAt: FUTURE });
    assert.equal(result.ok, true);
  }

  exchange() {
    return this.repository.exchangeAuthorizationCode({ codeHash: 'synthetic-code-hash', clientAppId: APP,
      redirectUri: REDIRECT, codeChallenge: 'synthetic-challenge', sessionId: SESSION,
      accessTokenHash: 'access-original', refreshTokenHash: 'refresh-original', accessExpiresAt: FUTURE, refreshExpiresAt: FUTURE });
  }

  rotate() {
    return this.repository.rotateRefreshToken({ refreshTokenHash: 'refresh-original', clientAppId: APP,
      accessTokenHash: 'access-next', nextRefreshTokenHash: 'refresh-next', accessExpiresAt: FUTURE });
  }

  revoke() { return this.repository.revokeAuthorization({ authorizationId: AUTH, clientAppId: APP }); }

  async assertNoCredentialsWork() {
    assert.equal(await this.repository.getSessionByAccessHash('access-original'), null);
    assert.equal(await this.repository.getSessionByAccessHash('access-next'), null);
    for (const hash of ['refresh-original', 'refresh-next']) {
      const result = await this.repository.rotateRefreshToken({ refreshTokenHash: hash, clientAppId: APP,
        accessTokenHash: 'must-not-exist', nextRefreshTokenHash: `must-not-exist-${hash}`, accessExpiresAt: FUTURE });
      assert.equal(result.ok, false, `${hash} cannot issue a new credential`);
    }
    assert.equal([...this.rows.token.values()].some((row) => row.status === 'active'), false);
  }
}
