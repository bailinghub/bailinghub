import { randomBytes } from 'node:crypto';
import { dt, dtIso } from '../../core/config/config-codec';

export interface AdminUser {
  username: string;
  display_name?: string;
  role: string;
  enabled: boolean;
  last_login_at?: string;
}

export interface AdminSession {
  session_id: string;
  username: string;
  role: string;
  expires_at: string;
}

export class AdminRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async hasAny(): Promise<boolean> {
    const [rows] = await this.pool.query('SELECT 1 AS present FROM bz_admins LIMIT 1');
    return rows.length > 0;
  }

  /**
   * 只在整个管理员表为空时创建首个账号。
   *
   * MySQL named lock 把多副本同时冷启动收敛为单个临界区；已有任意管理员时
   * 直接返回，不更新任何账号字段。显式 upsert 仍保留给后台管理和 admin:create。
   */
  async createInitial(
    username: string,
    passwordHash: string,
    displayName: string,
    role: 'admin',
  ): Promise<'created' | 'existing'> {
    const connection = await this.pool.getConnection();
    const lockName = 'bailinghub.bootstrap-admin.v1';
    let lockAcquired = false;
    let transactionOpen = false;
    try {
      const [lockRows] = await connection.query('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
      if (Number(lockRows?.[0]?.acquired) !== 1) {
        throw new Error('无法获取首次管理员初始化锁');
      }
      lockAcquired = true;

      await connection.beginTransaction();
      transactionOpen = true;
      const [existingRows] = await connection.query('SELECT 1 AS present FROM bz_admins LIMIT 1');
      if (existingRows.length > 0) {
        await connection.commit();
        transactionOpen = false;
        return 'existing';
      }

      const timestamp = dt();
      await connection.query(
        'INSERT INTO bz_admins (username,password_hash,display_name,role,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
        [username, passwordHash, displayName, role, timestamp, timestamp],
      );
      await connection.commit();
      transactionOpen = false;
      return 'created';
    } catch (error) {
      if (transactionOpen) await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      if (lockAcquired) {
        await connection.query('SELECT RELEASE_LOCK(?) AS released', [lockName]).catch(() => undefined);
      }
      connection.release();
    }
  }

  async get(username: string): Promise<(AdminUser & { password_hash: string }) | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_admins WHERE username=? LIMIT 1', [username]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      username: r.username,
      display_name: r.display_name ?? undefined,
      role: r.role ?? 'admin',
      enabled: !!r.enabled,
      last_login_at: r.last_login_at ? new Date(r.last_login_at).toISOString() : undefined,
      password_hash: r.password_hash,
    };
  }

  async list(): Promise<AdminUser[]> {
    const [rows] = await this.pool.query('SELECT username,display_name,role,enabled,last_login_at FROM bz_admins ORDER BY username');
    return (rows as any[]).map((r) => ({
      username: r.username,
      display_name: r.display_name ?? undefined,
      role: r.role ?? 'admin',
      enabled: !!r.enabled,
      last_login_at: r.last_login_at ? new Date(r.last_login_at).toISOString() : undefined,
    }));
  }

  async upsert(username: string, passwordHash: string, displayName?: string, role?: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_admins (username,password_hash,display_name,role,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?) ' +
        'ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),display_name=COALESCE(VALUES(display_name),display_name),role=COALESCE(?,role),updated_at=VALUES(updated_at)',
      [username, passwordHash, displayName ?? null, role ?? 'admin', dt(), dt(), role ?? null],
    );
  }

  async updateMeta(username: string, patch: { display_name?: string; role?: string; enabled?: boolean }): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.display_name !== undefined) { sets.push('display_name=?'); vals.push(patch.display_name); }
    if (patch.role !== undefined) { sets.push('role=?'); vals.push(patch.role); }
    if (patch.enabled !== undefined) { sets.push('enabled=?'); vals.push(patch.enabled ? 1 : 0); }
    if (!sets.length) return;
    sets.push('updated_at=?');
    vals.push(dt(), username);
    await this.pool.query(`UPDATE bz_admins SET ${sets.join(',')} WHERE username=?`, vals);
  }

  async delete(username: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_admin_sessions WHERE username=?', [username]);
    await this.pool.query('DELETE FROM bz_admins WHERE username=?', [username]);
  }

  async deleteSessionsFor(username: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_admin_sessions WHERE username=?', [username]);
  }

  async markLogin(username: string): Promise<void> {
    await this.pool.query('UPDATE bz_admins SET last_login_at=? WHERE username=?', [dt(), username]);
  }

  async createSession(username: string, ttlMs: number): Promise<string> {
    const sid = randomBytes(24).toString('hex');
    const exp = new Date(Date.now() + ttlMs).toISOString();
    await this.pool.query('DELETE FROM bz_admin_sessions WHERE expires_at < ?', [dt()]);
    await this.pool.query(
      'INSERT INTO bz_admin_sessions (session_id,username,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)',
      [sid, username, dt(), dtIso(exp), dt()],
    );
    return sid;
  }

  async getSession(sid: string, slideTtlMs: number): Promise<AdminSession | null> {
    if (!sid || sid.length !== 48) return null;
    const [rows] = await this.pool.query(
      'SELECT s.session_id,s.username,s.expires_at,a.role FROM bz_admin_sessions s JOIN bz_admins a ON a.username=s.username AND a.enabled=1 ' +
        'WHERE s.session_id=? AND s.expires_at >= ? LIMIT 1',
      [sid, dt()],
    );
    if (!rows[0]) return null;
    const exp = new Date(Date.now() + slideTtlMs).toISOString();
    void this.pool.query('UPDATE bz_admin_sessions SET last_seen_at=?, expires_at=? WHERE session_id=?', [dt(), dtIso(exp), sid])
      .catch(() => { /* 续期失败不影响本次请求 */ });
    return {
      session_id: rows[0].session_id,
      username: rows[0].username,
      role: rows[0].role ?? 'admin',
      expires_at: new Date(rows[0].expires_at).toISOString(),
    };
  }

  async deleteSession(sid: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_admin_sessions WHERE session_id=?', [sid]);
  }

  async deleteOtherSessions(username: string, keepSid: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_admin_sessions WHERE username=? AND session_id<>?', [username, keepSid]);
  }
}
