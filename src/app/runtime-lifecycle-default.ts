// OSS 默认运行期生命周期包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 runtime-lifecycle.ts 的 *For(deps) 入口。
import { cfg, cfgStore, isPaused, kbService, kbSync, store, toolIndex } from './runtime';
import { now, sleep } from './http';
import { drainInhubScheduler, kickInhubScheduler, recoverInhubJobs } from './engine-default';
import { refreshTargets } from '../core/targets/registry';
import {
  initializeRuntimeLifecycleFor,
  scheduleBootRecoveryFor,
  startRuntimeSchedulersFor,
  type RuntimeLifecycleDeps,
  type RuntimeSchedulers,
} from './runtime-lifecycle';

export function defaultRuntimeLifecycleDeps(): RuntimeLifecycleDeps {
  return {
    cfg,
    configStore: cfgStore,
    stateStore: store,
    kbService,
    kbSync,
    toolIndex,
    isPaused,
    refreshTargets,
    kickInhubScheduler,
    drainInhubScheduler,
    recoverInhubJobs,
    now,
    sleep,
  };
}

export async function initializeRuntimeLifecycle(): Promise<void> {
  await initializeRuntimeLifecycleFor(defaultRuntimeLifecycleDeps());
}

export function startRuntimeSchedulers(): RuntimeSchedulers {
  return startRuntimeSchedulersFor(defaultRuntimeLifecycleDeps());
}

export function scheduleBootRecovery(): ReturnType<typeof setTimeout> {
  return scheduleBootRecoveryFor(defaultRuntimeLifecycleDeps());
}
