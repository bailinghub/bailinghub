// OSS 默认后台运行面包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 admin-runtime.ts 的 handleAdminRuntimeApiFor(deps, ...)。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { channelSend } from '../app/channels-default';
import { requeueForRerun } from '../app/engine-default';
import { now } from '../app/http';
import { cfgStore, isPaused, queue, store } from '../app/runtime';
import type { Principal } from '../app/auth';
import { handleAdminRuntimeApiFor, type AdminRuntimeApiDeps } from './admin-runtime';

export function defaultAdminRuntimeApiDeps(): AdminRuntimeApiDeps {
  return {
    configStore: cfgStore,
    stateStore: store,
    now,
    isPaused,
    queueStats: () => queue.stats(),
    channelSend,
    engineRuntime: { requeueForRerun },
  };
}

export async function handleAdminRuntimeApi(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  principal: Principal,
): Promise<boolean> {
  return handleAdminRuntimeApiFor(defaultAdminRuntimeApiDeps(), method, path, req, res, principal);
}
