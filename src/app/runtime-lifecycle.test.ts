import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { ToolProvider } from '../core/contracts/types';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { ToolIndexService } from '../services/tools-index';
import { initializeRuntimeLifecycleFor, prewarmToolIndexesFor, startRuntimeSchedulersFor } from './runtime-lifecycle';

function toolProvider(name: string, input: Partial<ToolProvider> = {}): ToolProvider {
  return {
    name,
    base_url: 'https://tools.example.invalid',
    spec_source: 'inline',
    secret: 'secret',
    log_payload: false,
    timeout_ms: 10_000,
    rate_limit_per_min: 60,
    auto_refresh_min: 0,
    enabled: true,
    embed_credential: 'embed-main',
    embed_model: 'embedding-model-v1',
    embed_dim: 2,
    ...input,
  };
}

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

test('prewarmToolIndexesFor skips ineligible providers and continues after one provider fails', async () => {
  const attempts: string[] = [];
  const configStore = {
    toolProviders: {
      async list() {
        return [
          toolProvider('disabled', { enabled: false }),
          toolProvider('incomplete', { embed_model: undefined }),
          toolProvider('broken'),
          toolProvider('healthy'),
        ];
      },
    },
  } as unknown as ConfigStoreContract;
  const toolIndex = {
    async prewarmProvider(provider: string) {
      attempts.push(provider);
      if (provider === 'broken') throw new Error('index unavailable');
      return 7;
    },
  } as unknown as ToolIndexService;

  const summary = await prewarmToolIndexesFor(configStore, toolIndex);

  assert.deepEqual(attempts, ['broken', 'healthy']);
  assert.deepEqual(summary, { eligible: 2, warmed: 1, failed: 1, rows: 7 });
});

test('runtime schedulers start cold prewarm in the background without waiting for it', async (t) => {
  let prewarmCalls = 0;
  const configStore = {
    toolProviders: { async list() { return [toolProvider('orders')]; } },
  } as unknown as ConfigStoreContract;
  const toolIndex = {
    async prewarmProvider() {
      prewarmCalls++;
      return await new Promise<number>(() => undefined);
    },
  } as unknown as ToolIndexService;
  const stateStore = {
    async appendAudit() { /* prewarm never completes in this test */ },
  } as unknown as RuntimeStateStore;

  const schedulers = startRuntimeSchedulersFor({
    cfg: { auditRetentionDays: 0 } as AppConfig,
    configStore,
    stateStore,
    kbService: null,
    kbSync: null,
    toolIndex,
    isPaused: () => false,
    async refreshTargets() {},
    kickInhubScheduler() {},
    async drainInhubScheduler() { return 0; },
    async recoverInhubJobs() { return 0; },
    now: () => new Date(0).toISOString(),
    async sleep() {},
  });
  t.after(() => schedulers.stop());

  assert.equal(prewarmCalls, 0, 'scheduler construction must return before prewarm starts');
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(prewarmCalls, 1, 'prewarm should start on a background timer');
});
