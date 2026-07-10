import { randomBytes } from 'node:crypto';
import { dt, rowClient } from '../../core/config/config-codec';
import type { Client } from '../../core/contracts/types';

export class ClientRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async list(): Promise<Client[]> {
    const [rows] = await this.pool.query('SELECT * FROM bz_clients ORDER BY app_id');
    return (rows as any[]).map(rowClient);
  }

  async get(appId: string): Promise<Client | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_clients WHERE app_id=? LIMIT 1', [appId]);
    return rows[0] ? rowClient(rows[0]) : null;
  }

  async getByToken(token: string): Promise<Client | null> {
    if (!token || token.length < 16) return null;
    const [rows] = await this.pool.query('SELECT * FROM bz_clients WHERE token=? LIMIT 1', [token]);
    return rows[0] ? rowClient(rows[0]) : null;
  }

  async upsert(c: Omit<Client, 'token'>, rotateToken = false): Promise<string> {
    const existing = await this.get(c.app_id);
    const token = !existing || rotateToken ? randomBytes(16).toString('hex') : existing.token;
    await this.pool.query(
      'INSERT INTO bz_clients (app_id,name,token,allowed_routes,allowed_channels,rate_limit_per_min,budget,enabled,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE name=VALUES(name),token=VALUES(token),allowed_routes=VALUES(allowed_routes),allowed_channels=VALUES(allowed_channels),rate_limit_per_min=VALUES(rate_limit_per_min),budget=VALUES(budget),enabled=VALUES(enabled),description=VALUES(description),updated_at=VALUES(updated_at)',
      [c.app_id, c.name, token, JSON.stringify(c.allowed_routes ?? []), JSON.stringify(c.allowed_channels ?? []), c.rate_limit_per_min ?? 60,
       c.budget && Object.keys(c.budget).length ? JSON.stringify(c.budget) : null,
       c.enabled ? 1 : 0, c.description ?? null, dt(), dt()],
    );
    return token;
  }

  async delete(appId: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_clients WHERE app_id=?', [appId]);
  }

  async touch(appId: string): Promise<void> {
    await this.pool.query('UPDATE bz_clients SET last_used_at=? WHERE app_id=?', [dt(), appId]);
  }
}
