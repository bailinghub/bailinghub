// OSS 默认后台 API 包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 admin.ts 的 handleAdminApiFor(deps, ...)。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { channelSend } from '../app/channels-default';
import { requeueForRerun } from '../app/engine-default';
import { now, sleep } from '../app/http';
import { cfg, cfgStore, edition, isPaused, kbService, kbSync, queue, store, toolIndex } from '../app/runtime';
import type { Principal } from '../app/auth';
import { refreshTargets } from '../core/targets/registry';
import { handleAdminApiFor, type AdminApiDeps } from './admin';

export function defaultAdminApiDeps(): AdminApiDeps {
  return {
    cfg,
    configStore: cfgStore,
    stateStore: store,
    capabilities: edition.capabilities,
    kbService,
    kbSync,
    toolIndex,
    isPaused,
    now,
    sleep,
    queueStats: () => queue.stats(),
    channelSend,
    engineRuntime: { requeueForRerun },
    refreshTargets,
  };
}

export async function handleAdminApi(method: string, path: string, req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<boolean> {
  return handleAdminApiFor(defaultAdminApiDeps(), method, path, req, res, principal);
}
