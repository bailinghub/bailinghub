import { createHash } from 'node:crypto';
import { dt, dtAt } from '../../core/config/config-codec';
import type { RateLimitDecision, RateLimitRequest } from '../../core/contracts/tool-rate-limits';

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

  /** One connection, deterministic locks and one transaction: a rejected gate charges no other gate. */
  async consumeAll(requests: RateLimitRequest[]): Promise<RateLimitDecision> {
    const gates = requests.filter((gate) => gate.limit > 0);
    if (!gates.length) return { limited: false };
    const conn = await this.pool.getConnection();
    const locks: string[] = [];
    let transaction = false;
    try {
      for (const bucket of [...new Set(gates.map((gate) => gate.bucket))].sort()) {
        const name = this.lockName(bucket);
        const [rows] = await conn.query('SELECT GET_LOCK(?, 2) AS ok', [name]);
        if (Number(rows[0]?.ok) !== 1) throw new Error('rate limit lock timeout');
        locks.push(name);
      }
      await conn.beginTransaction();
      transaction = true;
      const now = Date.now();
      for (const gate of gates) {
        const cutoff = dtAt(now - gate.windowSec * 1000);
        const [rows] = await conn.query('SELECT COUNT(*) AS n FROM bz_rate_limits WHERE bucket=? AND created_at > ?', [gate.bucket, cutoff]);
        const count = Number(rows[0]?.n ?? 0);
        if (count >= gate.limit) {
          // Offset handles a limit lowered while the original window is still occupied.
          const [expiry] = await conn.query('SELECT created_at FROM bz_rate_limits WHERE bucket=? AND created_at > ? ORDER BY created_at, id LIMIT 1 OFFSET ?', [gate.bucket, cutoff, count - gate.limit]);
          const raw = expiry[0]?.created_at;
          const oldest = raw instanceof Date ? raw.getTime() : Date.parse(String(raw).replace(' ', 'T') + 'Z');
          await conn.rollback();
          transaction = false;
          return { limited: true, bucket: gate.bucket, retryAfterMs: Number.isFinite(oldest) ? Math.max(1, oldest + gate.windowSec * 1000 - now) : gate.windowSec * 1000 };
        }
      }
      for (const gate of gates) {
        await conn.query('DELETE FROM bz_rate_limits WHERE bucket=? AND created_at <= ?', [gate.bucket, dtAt(now - gate.windowSec * 1000)]);
        await conn.query('INSERT INTO bz_rate_limits (bucket, created_at) VALUES (?, ?)', [gate.bucket, dtAt(now)]);
      }
      await conn.commit();
      transaction = false;
      return { limited: false };
    } catch (error) {
      if (transaction) await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      for (const name of locks.reverse()) await conn.query('SELECT RELEASE_LOCK(?)', [name]).catch(() => undefined);
      conn.release();
    }
  }
}
