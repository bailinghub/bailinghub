// OSS 默认后台基础设施配置 API 包装：这里才绑定 app/runtime 单组织单例。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfgStore } from '../app/runtime';
import { handleAdminInfraApiFor, type AdminInfraApiDeps } from './admin-infra';

export function defaultAdminInfraApiDeps(): AdminInfraApiDeps {
  return { configStore: cfgStore };
}

export async function handleAdminInfraApi(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return handleAdminInfraApiFor(defaultAdminInfraApiDeps(), method, path, req, res);
}
