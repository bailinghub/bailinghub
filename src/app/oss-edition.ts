import type { AppConfig } from '../core/config/config';
import { type ConsoleCapabilities, createRuntimeContext, assertSingleScope, SingleScopeResolver, systemActor, type RuntimeContext, type StoreFactory } from '../core/edition';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import { AuditFailureTracker, observeAuditFailures, type AuditFailureLogger } from '../core/state/audit-observability';
import { ConfigStore } from '../infrastructure/config/configstore';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { createStore } from '../infrastructure/state/state';

export type OssConfigStore = ConfigStoreContract | null;

export interface OssEdition {
  name: 'oss';
  systemContext: RuntimeContext;
  scopeResolver: SingleScopeResolver;
  storeFactory: StoreFactory<OssConfigStore, RuntimeStateStore>;
  auditFailures: AuditFailureTracker;
  capabilities: ConsoleCapabilities;
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

export function createOssEdition(cfg: AppConfig, options: { logger?: AuditFailureLogger; now?: () => number } = {}): OssEdition {
  const auditFailures = new AuditFailureTracker(options.now);
  const stateStore = observeAuditFailures(createStore(cfg), auditFailures, options.logger);
  const configStore = cfg.state.backend === 'mysql' ? new ConfigStore(cfg.state.mysql) : null;
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
        'diagnostics',
        'accounts',
        'audit',
      ],
      limits: {},
    },
  };
}
