import type { AppConfig } from '../../core/config/config';
import { JsonlStore } from './state-jsonl';
import { MysqlStore } from './state-mysql';
import type { RuntimeStateStore } from '../../core/state/state-contracts';

export type { AuditLedger, JobRepository, RuntimeStateStore, RuntimeStateStore as StateStore } from '../../core/state/state-contracts';

export function createStore(cfg: AppConfig): RuntimeStateStore {
  return cfg.state.backend === 'mysql' ? new MysqlStore(cfg.state.mysql) : new JsonlStore(cfg.state.jsonlPath);
}
