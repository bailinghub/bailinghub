import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import { initializeRuntimeLifecycleFor } from './runtime-lifecycle';

test('initializeRuntimeLifecycleFor: Store 初始化后、目标刷新前执行启动契约', async () => {
  const events: string[] = [];
  const stateStore = {
    async init() { events.push('state:init'); },
  } as unknown as RuntimeStateStore;

  await initializeRuntimeLifecycleFor({
    cfg: {
      displayTz: 'Asia/Shanghai',
      displayTzLabel: '北京时间',
    } as AppConfig,
    configStore: null,
    stateStore,
    kbService: null,
    kbSync: null,
    toolIndex: null,
    isPaused: () => false,
    async refreshTargets() { events.push('targets:refresh'); },
    kickInhubScheduler() {},
    async drainInhubScheduler() { return 0; },
    async recoverInhubJobs() { return 0; },
    now: () => new Date(0).toISOString(),
    async sleep() {},
    async afterStoresInitialized() { events.push('bootstrap'); },
  });

  assert.deepEqual(events, ['state:init', 'bootstrap', 'targets:refresh']);
});
