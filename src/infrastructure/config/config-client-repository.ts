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
    await this.write(c, token, true);
    return token;
  }

  /** Insert-only variant for ownership-sensitive bootstrap flows. */
  async create(c: Omit<Client, 'token'>, explicitToken?: string): Promise<string> {
    const token = explicitToken ?? randomBytes(16).toString('hex');
    if (token.length < 16) throw new Error('client token 至少 16 位');
    await this.write(c, token, false);
    return token;
  }

  private async write(c: Omit<Client, 'token'>, token: string, updateExisting: boolean): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_clients (app_id,name,token,agent_authorize_url,allowed_routes,allowed_channels,rate_limit_per_min,budget,enabled,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ' +
        (updateExisting
          ? 'ON DUPLICATE KEY UPDATE name=VALUES(name),token=VALUES(token),agent_authorize_url=VALUES(agent_authorize_url),allowed_routes=VALUES(allowed_routes),allowed_channels=VALUES(allowed_channels),rate_limit_per_min=VALUES(rate_limit_per_min),budget=VALUES(budget),enabled=VALUES(enabled),description=VALUES(description),updated_at=VALUES(updated_at)'
          : ''),
      [c.app_id, c.name, token, c.agent_authorize_url ?? null, JSON.stringify(c.allowed_routes ?? []), JSON.stringify(c.allowed_channels ?? []), c.rate_limit_per_min ?? 60,
       c.budget && Object.keys(c.budget).length ? JSON.stringify(c.budget) : null,
       c.enabled ? 1 : 0, c.description ?? null, dt(), dt()],
    );
  }

  async replaceToken(appId: string, token: string): Promise<void> {
    if (token.length < 16) throw new Error('client token 至少 16 位');
    await this.pool.query('UPDATE bz_clients SET token=?,updated_at=? WHERE app_id=?', [token, dt(), appId]);
  }

  async delete(appId: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_clients WHERE app_id=?', [appId]);
  }

  async touch(appId: string): Promise<void> {
    await this.pool.query('UPDATE bz_clients SET last_used_at=? WHERE app_id=?', [dt(), appId]);
  }
}
