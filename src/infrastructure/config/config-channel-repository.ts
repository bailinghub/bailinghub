import { dt, mergeChannelSecrets, rowChannel } from '../../core/config/config-codec';
import type { Channel } from '../../core/contracts/types';

export class ChannelRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async list(): Promise<Channel[]> {
    const [rows] = await this.pool.query('SELECT * FROM bz_channels ORDER BY name');
    return (rows as any[]).map(rowChannel);
  }

  async get(name: string): Promise<Channel | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_channels WHERE name=? LIMIT 1', [name]);
    return rows[0] ? rowChannel(rows[0]) : null;
  }

  async upsert(c: Channel): Promise<void> {
    const existing = await this.get(c.name);
    const config = mergeChannelSecrets(c.config ?? {}, existing?.config);
    await this.pool.query(
      'INSERT INTO bz_channels (name,kind,route_key,config,enabled,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE kind=VALUES(kind),route_key=VALUES(route_key),config=VALUES(config),enabled=VALUES(enabled),description=VALUES(description),updated_at=VALUES(updated_at)',
      [c.name, c.kind, c.route_key, JSON.stringify(config), c.enabled ? 1 : 0, c.description ?? null, dt(), dt()]);
  }

  async delete(name: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_channels WHERE name=?', [name]);
  }
}
