import { randomBytes } from 'node:crypto';
import { dt, rowExecutorToken } from '../../core/config/config-codec';
import type { ExecutorToken } from '../../core/contracts/types';

export class ExecutorTokenRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async list(): Promise<ExecutorToken[]> {
    const [rows] = await this.pool.query('SELECT * FROM bz_executor_tokens ORDER BY name');
    return (rows as any[]).map(rowExecutorToken);
  }

  async get(name: string): Promise<ExecutorToken | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_executor_tokens WHERE name=? LIMIT 1', [name]);
    return rows[0] ? rowExecutorToken(rows[0]) : null;
  }

  async getByToken(token: string): Promise<ExecutorToken | null> {
    if (!token || token.length < 16) return null;
    const [rows] = await this.pool.query('SELECT * FROM bz_executor_tokens WHERE token=? LIMIT 1', [token]);
    return rows[0] ? rowExecutorToken(rows[0]) : null;
  }

  async upsert(t: Omit<ExecutorToken, 'token' | 'last_seen_at'>, rotateToken = false): Promise<string> {
    const existing = await this.get(t.name);
    const token = !existing || rotateToken ? randomBytes(16).toString('hex') : existing.token;
    await this.pool.query(
      'INSERT INTO bz_executor_tokens (name,token,allowed_targets,enabled,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE token=VALUES(token),allowed_targets=VALUES(allowed_targets),enabled=VALUES(enabled),description=VALUES(description),updated_at=VALUES(updated_at)',
      [t.name, token, JSON.stringify(t.allowed_targets ?? []), t.enabled ? 1 : 0, t.description ?? null, dt(), dt()],
    );
    return token;
  }

  async delete(name: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_executor_tokens WHERE name=?', [name]);
  }

  async touch(name: string): Promise<void> {
    await this.pool.query('UPDATE bz_executor_tokens SET last_seen_at=? WHERE name=?', [dt(), name]);
  }
}
