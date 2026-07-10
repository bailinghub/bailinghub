// OSS 默认鉴权包装：这里才绑定 app/runtime 单组织单例。
// 需要自定义部署复用时，直接使用 auth.ts 的 *For(deps) 入口，不 import 本文件。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg, cfgStore } from './runtime';
import type { Client } from '../core/contracts/types';
import { authenticateFor, handleLoginFor, handleLogoutFor, namedRateLimitedFor, rateLimitedFor, type Principal } from './auth';

export async function authenticate(req: IncomingMessage, url: URL): Promise<Principal | null> {
  return authenticateFor({ cfg, configStore: cfgStore }, req, url);
}

export async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleLoginFor({ cfg, configStore: cfgStore }, req, res);
}

export async function handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleLogoutFor({ cfg, configStore: cfgStore }, req, res);
}

export async function rateLimited(client: Client): Promise<boolean> {
  return rateLimitedFor(cfgStore, client);
}

export async function namedRateLimited(bucket: string, limit: number, windowSec = 60): Promise<boolean> {
  return namedRateLimitedFor(cfgStore, bucket, limit, windowSec);
}
