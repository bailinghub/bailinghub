// OSS 默认后台接入 API 包装：这里才绑定 app/runtime 单组织单例。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { now } from '../app/http';
import { cfgStore, store } from '../app/runtime';
import type { Principal } from '../app/auth';
import { handleAdminAccessApiFor, type AdminAccessApiDeps } from './admin-access';

export function defaultAdminAccessApiDeps(): AdminAccessApiDeps {
  return { configStore: cfgStore, stateStore: store, now };
}

export async function handleAdminAccessApi(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  principal: Principal,
): Promise<boolean> {
  return handleAdminAccessApiFor(defaultAdminAccessApiDeps(), method, path, req, res, principal);
}
