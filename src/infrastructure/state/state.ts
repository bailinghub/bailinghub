import type { AppConfig } from '../../core/config/config';
import { JsonlStore } from './state-jsonl';
import { MysqlStore } from './state-mysql';
import type { RuntimeStateStore } from '../../core/state/state-contracts';
import type { MysqlPoolResource } from '../mysql/pool-owner';

export type { AuditLedger, JobRepository, RuntimeStateStore, RuntimeStateStore as StateStore } from '../../core/state/state-contracts';

export function createStore(cfg: AppConfig, options: { mysqlPool?: MysqlPoolResource } = {}): RuntimeStateStore {
  return cfg.state.backend === 'mysql' ? new MysqlStore(cfg.state.mysql, options.mysqlPool) : new JsonlStore(cfg.state.jsonlPath);
}
