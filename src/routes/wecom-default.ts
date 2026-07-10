// OSS 默认企微入站包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 wecom.ts 的 handleWecomInboundFor(deps, ...)。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg, isPaused } from '../app/runtime';
import { resolveProjectPathFor, runtimeContextFor, runtimeStoresFor } from '../app/runtime-context-default';
import { now } from '../app/http';
import type { EngineRuntime } from '../app/engine';
import { launchJob, waitForJob } from '../app/engine-default';
import type { RuntimeContext } from '../core/edition';
import { handleWecomInboundFor, type WecomApiDeps } from './wecom';

export function defaultWecomApiDeps(): WecomApiDeps {
  return {
    cfg,
    isPaused,
    runtimeContextFor,
    runtimeStoresFor,
    resolveProjectPathFor,
    now,
    engineForContext: (_ctx: RuntimeContext): Pick<EngineRuntime, 'launchJob' | 'waitForJob'> => ({ launchJob, waitForJob }),
  };
}

export async function handleWecomInbound(req: IncomingMessage, res: ServerResponse, accountId: string, url: URL): Promise<void> {
  return handleWecomInboundFor(defaultWecomApiDeps(), req, res, accountId, url);
}
