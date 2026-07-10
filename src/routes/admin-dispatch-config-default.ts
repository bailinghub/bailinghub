// OSS 默认后台调度配置 API 包装：这里才绑定 app/runtime 单组织单例。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg, cfgStore } from '../app/runtime';
import { refreshTargets } from '../core/targets/registry';
import { handleAdminDispatchConfigApiFor, type AdminDispatchConfigApiDeps } from './admin-dispatch-config';

export function defaultAdminDispatchConfigApiDeps(): AdminDispatchConfigApiDeps {
  return { configStore: cfgStore, defaultProfile: cfg.defaultProfile, refreshTargets };
}

export async function handleAdminDispatchConfigApi(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return handleAdminDispatchConfigApiFor(defaultAdminDispatchConfigApiDeps(), method, path, req, res);
}
