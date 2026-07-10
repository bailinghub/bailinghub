import { createHash } from 'node:crypto';
import { dt, dtAt } from '../../core/config/config-codec';

export class RateLimitLedger {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  private lockName(bucket: string): string {
    return `bailing:rate:${createHash('sha256').update(bucket).digest('hex').slice(0, 48)}`;
  }

  private async withLock<T>(bucket: string, fn: (conn: any) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    const lockName = this.lockName(bucket);
    let locked = false;
    try {
      const [rows] = await conn.query('SELECT GET_LOCK(?, 2) AS ok', [lockName]);
      locked = Number((rows as any[])[0]?.ok ?? 0) === 1;
      if (!locked) throw new Error('rate limit lock timeout');
      return await fn(conn);
    } finally {
      if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined);
      conn.release();
    }
  }

  async count(bucket: string, windowSec: number): Promise<number> {
    const cutoff = dtAt(Date.now() - Math.max(1, windowSec) * 1000);
    return this.withLock(bucket, async (conn) => {
      await conn.query('DELETE FROM bz_rate_limits WHERE bucket=? AND created_at < ?', [bucket, cutoff]);
      const [rows] = await conn.query('SELECT COUNT(*) AS n FROM bz_rate_limits WHERE bucket=?', [bucket]);
      return Number((rows as any[])[0]?.n ?? 0);
    });
  }

  async record(bucket: string): Promise<void> {
    await this.pool.query('INSERT INTO bz_rate_limits (bucket, created_at) VALUES (?, ?)', [bucket, dt()]);
  }

  async consume(bucket: string, limit: number, windowSec: number): Promise<boolean> {
    if (!Number.isFinite(limit) || limit <= 0) return false;
    const cutoff = dtAt(Date.now() - Math.max(1, windowSec) * 1000);
    return this.withLock(bucket, async (conn) => {
      await conn.query('DELETE FROM bz_rate_limits WHERE bucket=? AND created_at < ?', [bucket, cutoff]);
      const [rows] = await conn.query('SELECT COUNT(*) AS n FROM bz_rate_limits WHERE bucket=?', [bucket]);
      if (Number((rows as any[])[0]?.n ?? 0) >= limit) return true;
      await conn.query('INSERT INTO bz_rate_limits (bucket, created_at) VALUES (?, ?)', [bucket, dt()]);
      return false;
    });
  }

  async clear(bucket: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_rate_limits WHERE bucket=?', [bucket]);
  }
}
