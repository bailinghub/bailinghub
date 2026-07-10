// OSS 默认知识库 API 包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 kb.ts 的 *For(deps) 入口。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfgStore, kbService, store } from '../app/runtime';
import { now } from '../app/http';
import type { Principal } from '../app/auth';
import { handleKbIngestFor, handleKbIngestListFor, handleKbSearchFor, type KbApiDeps } from './kb';

export function defaultKbApiDeps(): KbApiDeps {
  return { kbService, stateStore: store, configStore: cfgStore, now };
}

export async function handleKbSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleKbSearchFor(defaultKbApiDeps(), req, res);
}

export async function handleKbIngest(req: IncomingMessage, res: ServerResponse, p: Principal, method: string, kbId: string, sourceKey: string): Promise<void> {
  return handleKbIngestFor(defaultKbApiDeps(), req, res, p, method, kbId, sourceKey);
}

export async function handleKbIngestList(res: ServerResponse, p: Principal, kbId: string): Promise<void> {
  return handleKbIngestListFor(defaultKbApiDeps(), res, p, kbId);
}
