// OSS 默认后台工具源 API 包装：这里才绑定 app/runtime 单组织单例。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { now, sleep } from '../app/http';
import { cfg, cfgStore, store, toolIndex } from '../app/runtime';
import type { Principal } from '../app/auth';
import { handleAdminToolProviderApiFor, type AdminToolProviderApiDeps } from './admin-tool-providers';

export function defaultAdminToolProviderApiDeps(): AdminToolProviderApiDeps {
  return { cfg, configStore: cfgStore, stateStore: store, toolIndex, now, sleep };
}

export async function handleAdminToolProviderApi(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  principal: Principal,
): Promise<boolean> {
  return handleAdminToolProviderApiFor(defaultAdminToolProviderApiDeps(), method, path, req, res, principal);
}
