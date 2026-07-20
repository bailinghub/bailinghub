// 运行时组合根：中枢的默认进程只创建一组核心组件。
// 默认入口导出常用运行时实例；扩展入口使用 RuntimeContext -> StoreFactory 组合，
// 自定义实现可替换 edition/storeFactory，而无需 fork 核心运行时。
// 注意无循环依赖：本文件只 import 叶子库和 OSS edition，不 import server.ts 或任何路由模块。
import { existsSync } from 'node:fs';
import { loadConfig } from '../core/config/config';
import { createOssEdition } from './oss-edition';
import { createRuntimeComposition } from './runtime-composition';

export const cfg = loadConfig();
export const runtimeComposition = createRuntimeComposition({ cfg, edition: createOssEdition(cfg) });
export const edition = runtimeComposition.edition;
export const runtimeContext = runtimeComposition.runtimeContext;
export const storeFactory = runtimeComposition.storeFactory;
export const store = runtimeComposition.store;
export const queue = runtimeComposition.queue;
export const cfgStore = runtimeComposition.cfgStore;
export const kbService = runtimeComposition.kbService;
export const kbSync = runtimeComposition.kbSync;
export const toolIndex = runtimeComposition.toolIndex;
export const jobStream = runtimeComposition.jobStream;

// ---- 运行时状态/配置 helper（引擎与路由共用，故与单例同处）----
/** kill switch：存在该文件即全局暂停派活。 */
export function isPaused(): boolean { return existsSync(cfg.killSwitchFile); }

/** 项目名 → 本机绝对目录：MySQL 模式优先使用 bz_projects，文件模式使用 config.json 登记。 */
export async function resolveProjectPath(name: string): Promise<string | null> {
  if (cfgStore) {
    const p = await cfgStore.projects.get(name);
    if (p && p.enabled) return p.path;
  }
  return cfg.projects[name] ?? null;
}
