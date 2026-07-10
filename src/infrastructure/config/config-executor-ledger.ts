import { dt } from '../../core/config/config-codec';
import type { ExecutorCapabilities } from '../../core/contracts/types';

export class ExecutorLedger {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async touch(executorId: string, targets: string[], capabilities?: ExecutorCapabilities | null): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_executors (executor_id,targets,capabilities,last_seen_at,created_at) VALUES (?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE targets=VALUES(targets),capabilities=VALUES(capabilities),last_seen_at=VALUES(last_seen_at)',
      [executorId, JSON.stringify(targets), capabilities ? JSON.stringify(capabilities) : null, dt(), dt()],
    );
  }

  async list(): Promise<Array<{ executor_id: string; targets: string[]; capabilities: ExecutorCapabilities | null; last_seen_at: string }>> {
    const [rows] = await this.pool.query('SELECT * FROM bz_executors ORDER BY executor_id');
    return (rows as any[]).map((r) => ({
      executor_id: r.executor_id,
      targets: r.targets ? (typeof r.targets === 'string' ? JSON.parse(r.targets) : r.targets) : [],
      capabilities: r.capabilities ? (typeof r.capabilities === 'string' ? JSON.parse(r.capabilities) : r.capabilities) : null,
      last_seen_at: new Date(r.last_seen_at).toISOString(),
    }));
  }

  async delete(executorId: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_executors WHERE executor_id=?', [executorId]);
  }
}
