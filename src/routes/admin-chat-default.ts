// OSS 默认后台聊天配置 API 包装：这里才绑定 app/runtime 单组织单例。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfgStore } from '../app/runtime';
import { handleAdminChatApiFor, type AdminChatApiDeps } from './admin-chat';

export function defaultAdminChatApiDeps(): AdminChatApiDeps {
  return { configStore: cfgStore };
}

export async function handleAdminChatApi(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return handleAdminChatApiFor(defaultAdminChatApiDeps(), method, path, req, res);
}
