// OSS 默认 /run 包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 run.ts 的 handleRunFor(deps, ...)。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg, isPaused } from '../app/runtime';
import { resolveProjectPathFor, runtimeContextFor, runtimeStoresFor } from '../app/runtime-context-default';
import type { EngineRuntime } from '../app/engine';
import { launchJob } from '../app/engine-default';
import type { Principal } from '../app/auth';
import { handleRunFor, type RunApiDeps } from './run';

export function defaultRunApiDeps(): RunApiDeps {
  return {
    cfg,
    isPaused,
    runtimeContextFor,
    runtimeStoresFor,
    resolveProjectPathFor,
    engineForContext: (): Pick<EngineRuntime, 'launchJob'> => ({ launchJob }),
  };
}

export async function handleRun(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
  return handleRunFor(defaultRunApiDeps(), req, res, principal);
}
