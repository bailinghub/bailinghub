import type { AppConfig } from '../core/config/config';
import { sqlMigrationFiles } from '../core/platform/version';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export interface ReadinessReport {
  ready: boolean;
  checks: {
    state_backend: 'ok';
    database: 'ok' | 'skipped' | 'failed';
    migrations: { status: 'ok' | 'skipped' | 'pending' | 'failed'; pending: number };
  };
}

/**
 * 只检查实例接流量所需的共享依赖。模型、工具源和渠道属于业务依赖，波动时不应把整个实例从负载均衡摘除。
 */
export async function checkReadinessFor(cfg: AppConfig, configStore: ConfigStoreContract | null): Promise<ReadinessReport> {
  if (cfg.state.backend !== 'mysql') {
    return { ready: true, checks: { state_backend: 'ok', database: 'skipped', migrations: { status: 'skipped', pending: 0 } } };
  }
  if (!configStore) {
    return { ready: false, checks: { state_backend: 'ok', database: 'failed', migrations: { status: 'failed', pending: 0 } } };
  }
  try {
    await configStore.db.query('SELECT 1');
  } catch {
    return { ready: false, checks: { state_backend: 'ok', database: 'failed', migrations: { status: 'failed', pending: 0 } } };
  }
  try {
    const applied = new Set(await configStore.observability.listSchemaMigrations());
    const pending = sqlMigrationFiles(cfg.root).filter((file) => !applied.has(file));
    return {
      ready: pending.length === 0,
      checks: { state_backend: 'ok', database: 'ok', migrations: { status: pending.length ? 'pending' : 'ok', pending: pending.length } },
    };
  } catch {
    return { ready: false, checks: { state_backend: 'ok', database: 'ok', migrations: { status: 'failed', pending: 0 } } };
  }
}
