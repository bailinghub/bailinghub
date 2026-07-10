// OSS 默认执行器通道包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 executor.ts 的 *For(deps) 入口。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg, isPaused, toolIndex } from '../app/runtime';
import { resolveProjectPathFor, runtimeContextFor, runtimeStoresFor } from '../app/runtime-context-default';
import { now, sleep } from '../app/http';
import type { EngineRuntime } from '../app/engine';
import { finish } from '../app/engine-default';
import { toolsForWorkItemFor } from '../app/tool-proxy';
import type { Principal } from '../app/auth';
import type { RuntimeContext } from '../core/edition';
import {
  handleExecutorClaimFor,
  handleExecutorHeartbeatFor,
  handleExecutorResultFor,
  type ExecutorApiDeps,
} from './executor';

export function defaultExecutorApiDeps(): ExecutorApiDeps {
  return {
    cfg,
    toolIndex,
    isPaused,
    runtimeContextFor,
    runtimeStoresFor,
    resolveProjectPathFor,
    now,
    sleep,
    toolsForWorkItemFor,
    engineForContext: (_ctx: RuntimeContext): Pick<EngineRuntime, 'finish'> => ({ finish }),
  };
}

export async function handleExecutorClaim(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
  return handleExecutorClaimFor(defaultExecutorApiDeps(), req, res, principal);
}

export async function handleExecutorHeartbeat(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
  return handleExecutorHeartbeatFor(defaultExecutorApiDeps(), req, res, principal);
}

export async function handleExecutorResult(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleExecutorResultFor(defaultExecutorApiDeps(), req, res);
}
