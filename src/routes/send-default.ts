// OSS 默认 /send 包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 send.ts 的 handleSendFor(deps, ...)。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg, isPaused } from '../app/runtime';
import { runtimeContextFor, runtimeStoresFor } from '../app/runtime-context-default';
import { now } from '../app/http';
import { channelSendFor } from '../app/channels';
import type { Principal } from '../app/auth';
import { handleSendFor, type SendApiDeps } from './send';

export function defaultSendApiDeps(): SendApiDeps {
  return {
    cfg,
    isPaused,
    runtimeContextFor,
    runtimeStoresFor,
    now,
    channelSendFor,
  };
}

export async function handleSend(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
  return handleSendFor(defaultSendApiDeps(), req, res, principal);
}
