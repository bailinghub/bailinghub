// OSS 默认后台知识库 API 包装：这里才绑定 app/runtime 单组织单例。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { now } from '../app/http';
import { kbService, kbSync, store } from '../app/runtime';
import { handleAdminKbApiFor, type AdminKbApiDeps } from './admin-kb';

export function defaultAdminKbApiDeps(): AdminKbApiDeps {
  return { kbService, kbSync, stateStore: store, now };
}

export async function handleAdminKbApi(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return handleAdminKbApiFor(defaultAdminKbApiDeps(), method, path, req, res);
}
