// 运行时组合器：把配置、edition、storeFactory 和核心服务装配成一个运行时对象。
// 这个文件不读取 config.json、不创建 OSS 单例；扩展发行版应复用这里，而不是 import app/runtime.ts。
import type { AppConfig } from '../core/config/config';
import type { RuntimeContext, StoreFactory } from '../core/edition';
import { Queue } from '../core/platform/queue';
import { registerTargetAdapter } from '../core/targets/registry';
import { llmAdapter } from '../adapters/targets/llm';
import { demoAgentAdapter } from '../adapters/targets/demo-agent';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import { KbService } from '../services/kb';
import { KbSyncService } from '../services/kbsync';
import { ToolIndexService } from '../services/tools-index';

export interface RuntimeCompositionEdition {
  systemContext: RuntimeContext;
  storeFactory: StoreFactory<ConfigStoreContract | null, RuntimeStateStore>;
}

export interface RuntimeComposition<EditionT extends RuntimeCompositionEdition = RuntimeCompositionEdition> {
  cfg: AppConfig;
  edition: EditionT;
  runtimeContext: RuntimeContext;
  storeFactory: StoreFactory<ConfigStoreContract | null, RuntimeStateStore>;
  store: RuntimeStateStore;
  queue: Queue;
  cfgStore: ConfigStoreContract | null;
  kbService: KbService | null;
  kbSync: KbSyncService | null;
  toolIndex: ToolIndexService | null;
}

let builtinAdaptersRegistered = false;

export function registerBuiltinTargetAdapters(): void {
  if (builtinAdaptersRegistered) return;
  registerTargetAdapter('llm', llmAdapter);
  registerTargetAdapter('demo-agent', demoAgentAdapter);
  builtinAdaptersRegistered = true;
}

export function createRuntimeComposition<EditionT extends RuntimeCompositionEdition>(input: {
  cfg: AppConfig;
  edition: EditionT;
  registerAdapters?: boolean;
}): RuntimeComposition<EditionT> {
  if (input.registerAdapters !== false) registerBuiltinTargetAdapters();
  const runtimeContext = input.edition.systemContext;
  const storeFactory = input.edition.storeFactory;
  const store = storeFactory.state(runtimeContext);
  const cfgStore = storeFactory.config(runtimeContext);
  const kbService = cfgStore ? new KbService(cfgStore, input.cfg, cfgStore.knowledge) : null;
  return {
    cfg: input.cfg,
    edition: input.edition,
    runtimeContext,
    storeFactory,
    store,
    queue: new Queue(input.cfg.concurrency),
    cfgStore,
    kbService,
    kbSync: cfgStore && kbService ? new KbSyncService(cfgStore.kbDatasources, kbService) : null,
    toolIndex: cfgStore ? new ToolIndexService(cfgStore, input.cfg, cfgStore.toolEmbeddings) : null,
  };
}
