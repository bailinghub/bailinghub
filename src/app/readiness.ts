import type { AppConfig } from '../core/config/config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { SchemaReadinessDatabase } from '../core/contracts/schema-readiness';
import { inspectCoreSchemaReadiness } from '../infrastructure/schema/schema-readiness';

export interface ReadinessReport {
  ready: boolean;
  checks: {
    state_backend: 'ok';
    database: 'ok' | 'skipped' | 'failed';
    migrations: { status: 'ok' | 'skipped' | 'pending' | 'failed'; pending: number };
  };
}

/** Shared storage only: external model, tool and channel failures belong to business diagnostics. */
export async function checkReadinessFor(
  cfg: AppConfig, configStore: ConfigStoreContract | null, stateStore?: Pick<RuntimeStateStore, 'schemaReadinessDb'>,
): Promise<ReadinessReport> {
  try {
    // A custom MySQL state store must expose its actual resource. Guessing from
    // config or checking only the configuration DB can admit a broken instance.
    if (cfg.state.backend === 'mysql' && (!configStore || !stateStore?.schemaReadinessDb)) {
      return { ready: false, checks: { state_backend: 'ok', database: 'failed', migrations: { status: 'failed', pending: 0 } } };
    }
    const resources = new Set<SchemaReadinessDatabase>();
    if (stateStore?.schemaReadinessDb) resources.add(stateStore.schemaReadinessDb);
    if (configStore) resources.add(configStore.db);
    if (!resources.size) {
      return { ready: true, checks: { state_backend: 'ok', database: 'skipped', migrations: { status: 'skipped', pending: 0 } } };
    }
    const checks = await Promise.all([...resources].map(inspectCoreSchemaReadiness));
    const database = checks.some(check => check.database === 'failed') ? 'failed' : 'ok';
    // Count distinct missing migration files, even when separate pool objects
    // refer to one schema. Never merge resources by guessed connection settings.
    const pending = new Set(checks.flatMap(check => check.pendingFilenames)).size;
    const status = checks.some(check => check.migrations.status === 'failed') ? 'failed' : pending ? 'pending' : 'ok';
    return { ready: database === 'ok' && status === 'ok', checks: { state_backend: 'ok', database, migrations: { status, pending } } };
  } catch {
    // Getter/adapter errors must not disclose connection strings or SQL details.
    return { ready: false, checks: { state_backend: 'ok', database: 'failed', migrations: { status: 'failed', pending: 0 } } };
  }
}
