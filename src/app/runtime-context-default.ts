// OSS 默认运行上下文包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 runtime-context.ts 的 createRuntimeContextHelpers(deps)。
import { cfg, edition, storeFactory } from './runtime';
import type { Principal } from './auth';
import type { RuntimeActor, RuntimeContext, RuntimeSource, ScopeResolver } from '../core/edition';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { createRuntimeContextHelpers } from './runtime-context';

const defaultRuntimeContextHelpers = createRuntimeContextHelpers({
  cfg,
  scopeResolver: edition.scopeResolver as ScopeResolver<Principal | null | undefined>,
  storeFactory,
});

export async function runtimeContextFor(input: {
  source: RuntimeSource;
  requestId: string;
  principal?: Principal | null;
  actor?: RuntimeActor;
}): Promise<RuntimeContext> {
  return defaultRuntimeContextHelpers.runtimeContextFor(input);
}

export function runtimeStoresFor(ctx: RuntimeContext) {
  return defaultRuntimeContextHelpers.runtimeStoresFor(ctx);
}

export async function resolveProjectPathFor(config: ConfigStoreContract | null, name: string): Promise<string | null> {
  return defaultRuntimeContextHelpers.resolveProjectPathFor(config, name);
}
