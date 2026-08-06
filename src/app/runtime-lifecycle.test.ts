import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { ToolProvider } from '../core/contracts/types';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { ToolIndexService } from '../services/tools-index';
import {
  createManagedRuntimeMaintenanceFor,
  createManagedRuntimeMaintenanceStateV1,
  initializeRuntimeLifecycleFor,
  prewarmToolIndexesFor,
  startRuntimeSchedulersFor,
  type RuntimeLifecycleDeps,
} from './runtime-lifecycle';

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

test('managed maintenance tick drives every standalone maintenance class without per-kernel timers', async () => {
  let clock = 0;
  const calls = {
    providerLists: 0,
    monitorSnapshots: 0,
    kbSync: 0,
    targetRefresh: 0,
    targetKick: 0,
    drains: 0,
    bootRecoveries: 0,
    staleRecoveries: 0,
    dispatchedReaps: 0,
    queuedExpiries: 0,
    toolCallCleanups: 0,
    auditCleanups: 0,
  };
  const configStore = {
    toolProviders: { async list() { calls.providerLists++; return []; } },
    executors: { async list() { return []; } },
    observability: {
      async monitorSnapshot() {
        calls.monitorSnapshots++;
        return { errors_15m: 0, oldest_queued_min: 0 };
      },
    },
    toolCalls: { async cleanup() { calls.toolCallCleanups++; return 0; } },
  } as unknown as ConfigStoreContract;
  const stateStore = {
    async listJobsByStatus() { return []; },
    async appendAudit() {},
    async requeueStaleDispatched() { calls.dispatchedReaps++; return 0; },
    async expireStaleQueued() { calls.queuedExpiries++; return 0; },
    async pruneAuditOlderThan() { calls.auditCleanups++; return 0; },
  } as unknown as RuntimeStateStore;
  const deps: RuntimeLifecycleDeps = {
    cfg: { auditRetentionDays: 7, alerts: null } as AppConfig,
    configStore,
    stateStore,
    kbService: null,
    kbSync: {
      async tick() { calls.kbSync++; },
    } as unknown as RuntimeLifecycleDeps['kbSync'],
    toolIndex: {
      async prewarmProvider() { return 0; },
    } as unknown as ToolIndexService,
    isPaused: () => false,
    async refreshTargets() { calls.targetRefresh++; },
    kickInhubScheduler() { calls.targetKick++; },
    async drainInhubScheduler() { calls.drains++; return 2; },
    async recoverInhubJobs(scope) {
      if (scope === 'boot') calls.bootRecoveries++;
      else calls.staleRecoveries++;
      return 0;
    },
    now: () => new Date(clock).toISOString(),
    async sleep() {},
  };
  const maintenance = createManagedRuntimeMaintenanceFor(deps, { nowMs: () => clock });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(await maintenance.tick(), 2);
  clock = 1_999;
  await maintenance.tick();
  await settle();
  assert.equal(calls.bootRecoveries, 0);

  clock = 2_000;
  await maintenance.tick();
  await settle();
  assert.equal(calls.bootRecoveries, 1);

  clock = 60_000;
  await maintenance.tick();
  await maintenance.tick();
  await settle();

  clock = 6 * 60 * 60_000;
  await maintenance.tick();
  await maintenance.stop();

  assert.deepEqual(calls, {
    providerLists: 3, // 冷预热 1 次 + spec 巡检 2 次
    monitorSnapshots: 2,
    kbSync: 2,
    targetRefresh: 2,
    targetKick: 2,
    drains: 6,
    bootRecoveries: 1,
    staleRecoveries: 2,
    dispatchedReaps: 2,
    queuedExpiries: 2,
    toolCallCleanups: 1,
    auditCleanups: 2,
  });
  assert.equal(await maintenance.tick(), 0, 'stopped maintenance must reject future work without throwing');
  assert.equal(calls.drains, 6);
});

test('managed maintenance singleflights long jobs; bounded stop fails closed and can be retried', async () => {
  let clock = 0;
  let kbTicks = 0;
  let releaseKb!: () => void;
  const kbGate = new Promise<void>((resolve) => { releaseKb = resolve; });
  const stateStore = {
    async listJobsByStatus() { return []; },
    async appendAudit() {},
    async requeueStaleDispatched() { return 0; },
    async expireStaleQueued() { return 0; },
    async pruneAuditOlderThan() { return 0; },
  } as unknown as RuntimeStateStore;
  const maintenance = createManagedRuntimeMaintenanceFor({
    cfg: { auditRetentionDays: 0, alerts: null } as AppConfig,
    configStore: null,
    stateStore,
    kbService: null,
    kbSync: {
      async tick() {
        kbTicks++;
        await kbGate;
      },
    } as unknown as RuntimeLifecycleDeps['kbSync'],
    toolIndex: null,
    isPaused: () => false,
    async refreshTargets() {},
    kickInhubScheduler() {},
    async drainInhubScheduler() { return 0; },
    async recoverInhubJobs() { return 0; },
    now: () => new Date(clock).toISOString(),
    async sleep() {},
  }, { nowMs: () => clock });

  clock = 60_000;
  await maintenance.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  clock = 120_000;
  await maintenance.tick();
  assert.equal(kbTicks, 1, 'an overdue tick must not overlap a still-running maintenance job');

  assert.equal(await maintenance.stop(5), false, 'timeout must keep the tenant stores alive while maintenance is running');
  assert.equal(await maintenance.tick(), 0, 'a timed-out stop must still reject new maintenance work');
  releaseKb();
  assert.equal(await maintenance.stop(100), true, 'the same stopped maintenance object must be retryable');
});

test('managed maintenance due state survives idle Kernel eviction without retaining Store resources', async () => {
  let clock = 0;
  let bootRecoveries = 0;
  let staleRecoveries = 0;
  let targetRefreshes = 0;
  const state = createManagedRuntimeMaintenanceStateV1();
  const deps = (): RuntimeLifecycleDeps => ({
    cfg: { auditRetentionDays: 0, alerts: null } as AppConfig,
    configStore: null,
    stateStore: {
      async appendAudit() {},
      async requeueStaleDispatched() { return 0; },
      async expireStaleQueued() { return 0; },
    } as unknown as RuntimeStateStore,
    kbService: null,
    kbSync: null,
    toolIndex: null,
    isPaused: () => false,
    async refreshTargets() { targetRefreshes++; },
    kickInhubScheduler() {},
    async drainInhubScheduler() { return 0; },
    async recoverInhubJobs(scope) {
      if (scope === 'boot') bootRecoveries++;
      else staleRecoveries++;
      return 0;
    },
    now: () => new Date(clock).toISOString(),
    async sleep() {},
  });

  const first = createManagedRuntimeMaintenanceFor(deps(), { nowMs: () => clock, state });
  await first.tick();
  await first.stop();

  // A new Kernel appears after the original instance was evicted. The stored
  // due points must be evaluated against the original schedule, not reset now.
  clock = 60_000;
  const second = createManagedRuntimeMaintenanceFor(deps(), { nowMs: () => clock, state });
  await second.tick();
  await second.stop();
  assert.equal(bootRecoveries, 1);
  assert.equal(staleRecoveries, 1);
  assert.equal(targetRefreshes, 1);

  const third = createManagedRuntimeMaintenanceFor(deps(), { nowMs: () => clock, state });
  await third.tick();
  await third.stop();
  assert.equal(bootRecoveries, 1, 'one-shot recovery must not restart after another eviction');
  assert.equal(staleRecoveries, 1, 'recurring maintenance must retain its next due point');
});
