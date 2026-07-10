// OSS 默认调度引擎包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应直接使用 engine.ts 的 createEngineRuntime(deps)。
import { cfg, cfgStore, isPaused, kbService, queue, resolveProjectPath, store, toolIndex } from './runtime';
import { now, sleep } from './http';
import type { Job } from '../core/contracts/types';
import type { LaunchSpec } from '../core/runtime/launch-runtime';
import { createEngineRuntime, type EngineRuntimeDeps } from './engine';

function defaultEngineDeps(): EngineRuntimeDeps {
  return {
    cfg,
    configStore: cfgStore,
    stateStore: store,
    kbService,
    toolIndex,
    queue,
    isPaused,
    resolveProjectPath,
    now,
    sleep,
  };
}

const defaultEngine = createEngineRuntime(defaultEngineDeps());

export async function waitForJob(jobId: string, waitMs: number): Promise<Job | null> {
  return defaultEngine.waitForJob(jobId, waitMs);
}

export async function launchJob(s: LaunchSpec): Promise<Job> {
  return defaultEngine.launchJob(s);
}

export async function requeueForRerun(job: Job, by: string, via: string): Promise<void> {
  await defaultEngine.requeueForRerun(job, by, via);
}

export async function recoverInhubJobs(scope: 'boot' | 'stale', staleMs: number): Promise<number> {
  return defaultEngine.recoverInhubJobs(scope, staleMs);
}

export function kickInhubScheduler(): void {
  defaultEngine.kickInhubScheduler();
}

export async function drainInhubScheduler(maxClaims = 1): Promise<number> {
  return await defaultEngine.drainInhubScheduler(maxClaims);
}

export async function finish(job: Job, patch: Partial<Job>): Promise<void> {
  await defaultEngine.finish(job, patch);
}
