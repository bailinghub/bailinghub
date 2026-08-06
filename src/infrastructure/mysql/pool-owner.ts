import { createPool, type Pool } from 'mysql2/promise';
import type { AppConfig } from '../../core/config/config';

export interface MysqlPoolResource {
  get(): Promise<Pool>;
  close(): Promise<void>;
}

/**
 * 一个 Kernel 对一个 MySQL Pool。
 *
 * ConfigStore 与 RuntimeStateStore 使用同一 schema，必须共享这个 owner，避免每个 Kernel
 * 默认创建两组连接；不同 Kernel 绝不能共享 owner，因为 Core SQL 使用未限定 schema 的表名。
 */
export class MysqlPoolOwner implements MysqlPoolResource {
  private pool: Pool | null = null;
  private closePromise: Promise<void> | null = null;
  private closing = false;
  private closed = false;

  constructor(private readonly cfg: AppConfig['state']['mysql']) {}

  async get(): Promise<Pool> {
    if (this.closing || this.closed) throw new Error('mysql pool owner is closed');
    this.pool ??= createPool({
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.cfg.database,
      waitForConnections: true,
      connectionLimit: this.cfg.connectionLimit,
      timezone: 'Z',
    });
    return this.pool;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    const pool = this.pool;
    const work = (async () => {
      if (pool) await pool.end();
      this.pool = null;
      this.closed = true;
    })();
    this.closePromise = work;
    try {
      await work;
    } catch (error) {
      if (this.closePromise === work) this.closePromise = null;
      throw error;
    }
  }
}
