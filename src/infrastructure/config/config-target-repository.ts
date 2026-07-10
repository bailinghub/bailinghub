import { dt, rowTarget } from '../../core/config/config-codec';
import type { TargetDef } from '../../core/contracts/types';

export class TargetRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async list(): Promise<TargetDef[]> {
    const [rows] = await this.pool.query('SELECT * FROM bz_targets ORDER BY name');
    return (rows as any[]).map(rowTarget);
  }

  async upsert(t: TargetDef): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_targets (name,kind,stateless,needs_project,timeout_ms,enabled,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE kind=VALUES(kind),stateless=VALUES(stateless),needs_project=VALUES(needs_project),timeout_ms=VALUES(timeout_ms),enabled=VALUES(enabled),description=VALUES(description),updated_at=VALUES(updated_at)',
      [t.name, t.kind, t.stateless ? 1 : 0, t.needs_project ? 1 : 0, t.timeout_ms ?? 0, t.enabled ? 1 : 0, t.description ?? null, dt(), dt()],
    );
  }

  async delete(name: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_targets WHERE name=?', [name]);
  }
}
