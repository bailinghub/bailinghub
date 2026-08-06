import type { AppConfig } from '../core/config/config';
import { type ConsoleCapabilities, createRuntimeContext, assertSingleScope, SingleScopeResolver, systemActor, type RuntimeContext, type StoreFactory } from '../core/edition';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import { AuditFailureTracker, observeAuditFailures, type AuditFailureLogger } from '../core/state/audit-observability';
import { ConfigStore } from '../infrastructure/config/configstore';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { InstanceBrandingProvider } from '../core/platform/instance-branding';
import { LocalInstanceBrandingProvider } from '../infrastructure/config/local-instance-branding-provider';
import { createStore } from '../infrastructure/state/state';
import { MysqlPoolOwner, type MysqlPoolResource } from '../infrastructure/mysql/pool-owner';

export type OssConfigStore = ConfigStoreContract | null;

export interface OssEdition {
  name: 'oss';
  systemContext: RuntimeContext;
  scopeResolver: SingleScopeResolver;
  storeFactory: StoreFactory<OssConfigStore, RuntimeStateStore>;
  auditFailures: AuditFailureTracker;
  brandingProvider: InstanceBrandingProvider;
  capabilities: ConsoleCapabilities;
  close(): Promise<void>;
}

export class OssStoreFactory implements StoreFactory<OssConfigStore, RuntimeStateStore> {
  constructor(
    private readonly stateStore: RuntimeStateStore,
    private readonly configStore: OssConfigStore,
  ) {}

  config(ctx: RuntimeContext): OssConfigStore {
    assertSingleScope(ctx);
    return this.configStore;
  }

  state(ctx: RuntimeContext): RuntimeStateStore {
    assertSingleScope(ctx);
    return this.stateStore;
  }
}

export function createOssEdition(cfg: AppConfig, options: {
  logger?: AuditFailureLogger;
  now?: () => number;
  /** Internal composition seam used to verify bounded/idempotent resource close. */
  mysqlPool?: MysqlPoolResource;
} = {}): OssEdition {
  const auditFailures = new AuditFailureTracker(options.now);
  const mysqlPool = cfg.state.backend === 'mysql' ? options.mysqlPool ?? new MysqlPoolOwner(cfg.state.mysql) : undefined;
  const stateStore = observeAuditFailures(createStore(cfg, { mysqlPool }), auditFailures, options.logger);
  const configStore = cfg.state.backend === 'mysql' ? new ConfigStore(cfg.state.mysql, mysqlPool) : null;
  const brandingProvider = new LocalInstanceBrandingProvider(configStore?.instanceBranding ?? null);
  let closePromise: Promise<void> | null = null;
  const closeResources = async (): Promise<void> => {
    if (closePromise) return await closePromise;
    const work = (async () => {
      if (mysqlPool) await mysqlPool.close();
      else await stateStore.close?.();
    })();
    closePromise = work;
    try {
      await work;
    } catch (error) {
      if (closePromise === work) closePromise = null;
      throw error;
    }
  };
  const systemContext = createRuntimeContext({
    requestId: 'boot',
    source: 'system',
    actor: systemActor('bailinghub'),
  });
  return {
    name: 'oss',
    systemContext,
    scopeResolver: new SingleScopeResolver(),
    storeFactory: new OssStoreFactory(stateStore, configStore),
    auditFailures,
    brandingProvider,
    capabilities: {
      edition: 'oss',
      console: 'single',
      modules: [
        'routes',
        'clients',
        'chat',
        'channels',
        'targets',
        'tools',
        'kb',
        'credentials',
        'storage',
        'projects',
        'runs',
        'executors',
        'cost',
        'approvals',
        'system',
        'settings',
        'diagnostics',
        'accounts',
        'audit',
      ],
      limits: {},
    },
    close: closeResources,
  };
}
