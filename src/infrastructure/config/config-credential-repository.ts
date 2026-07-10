import { dt, rowCredential } from '../../core/config/config-codec';
import type { Credential } from '../../core/contracts/types';

export class CredentialRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async list(): Promise<Credential[]> {
    const [rows] = await this.pool.query('SELECT * FROM bz_credentials ORDER BY name');
    return (rows as any[]).map(rowCredential);
  }

  async get(name: string): Promise<Credential | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_credentials WHERE name=? LIMIT 1', [name]);
    return rows[0] ? rowCredential(rows[0]) : null;
  }

  async upsert(c: Credential): Promise<void> {
    let key = c.api_key;
    if (!key) {
      const existing = await this.get(c.name);
      if (!existing) throw new Error('新建凭证必须填 API Key');
      key = existing.api_key;
    }
    await this.pool.query(
      'INSERT INTO bz_credentials (name,kind,base_url,api_key,default_model,enabled,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE kind=VALUES(kind),base_url=VALUES(base_url),api_key=VALUES(api_key),default_model=VALUES(default_model),enabled=VALUES(enabled),description=VALUES(description),updated_at=VALUES(updated_at)',
      [c.name, c.kind, c.base_url, key, c.default_model ?? null, c.enabled ? 1 : 0, c.description ?? null, dt(), dt()]);
  }

  async delete(name: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_credentials WHERE name=?', [name]);
  }

  async touch(name: string): Promise<void> {
    await this.pool.query('UPDATE bz_credentials SET last_used_at=? WHERE name=?', [dt(), name]);
  }
}
