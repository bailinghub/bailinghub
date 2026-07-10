import type { Principal } from './auth';
import type { AppConfig } from '../core/config/config';
import type { RuntimeActor, RuntimeContext, RuntimeSource, ScopeResolver, StoreFactory } from '../core/edition';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export function actorForPrincipal(principal: Principal | null | undefined): RuntimeActor | undefined {
  if (!principal) return undefined;
  if (principal.kind === 'admin') {
    return {
      kind: 'admin',
      id: principal.username ?? principal.via,
      roles: principal.via === 'token' ? ['admin', 'token'] : [principal.role ?? 'admin'],
      displayName: principal.username,
    };
  }
  if (principal.kind === 'client') {
    return {
      kind: 'client',
      id: principal.client.app_id,
      roles: ['client'],
      displayName: principal.client.name,
    };
  }
  return {
    kind: 'executor',
    id: principal.token.name,
    roles: ['executor'],
    displayName: principal.token.name,
  };
}

export interface RuntimeContextHelpers {
  runtimeContextFor(input: {
    source: RuntimeSource;
    requestId: string;
    principal?: Principal | null;
    actor?: RuntimeActor;
  }): Promise<RuntimeContext>;
  runtimeStoresFor(ctx: RuntimeContext): {
    state: RuntimeStateStore;
    config: ConfigStoreContract | null;
  };
  resolveProjectPathFor(config: ConfigStoreContract | null, name: string): Promise<string | null>;
}

export interface RuntimeContextHelperDeps {
  cfg: Pick<AppConfig, 'projects'>;
  scopeResolver: ScopeResolver<Principal | null | undefined>;
  storeFactory: StoreFactory<ConfigStoreContract | null, RuntimeStateStore>;
  actorForPrincipal?: (principal: Principal | null | undefined) => RuntimeActor | undefined;
}

export function createRuntimeContextHelpers(deps: RuntimeContextHelperDeps): RuntimeContextHelpers {
  const toActor = deps.actorForPrincipal ?? actorForPrincipal;
  return {
    async runtimeContextFor(input) {
      return deps.scopeResolver.resolve({
        source: input.source,
        requestId: input.requestId,
        auth: input.principal,
        actor: input.actor ?? toActor(input.principal),
      });
    },
    runtimeStoresFor(ctx) {
      return {
        state: deps.storeFactory.state(ctx),
        config: deps.storeFactory.config(ctx),
      };
    },
    async resolveProjectPathFor(config, name) {
      if (config) {
        const p = await config.projects.get(name);
        if (p && p.enabled) return p.path;
      }
      return deps.cfg.projects[name] ?? null;
    },
  };
}
