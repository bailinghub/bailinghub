import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import { createManagedRuntimeMaintenanceFor, createManagedRuntimeMaintenanceStateV1, startRuntimeSchedulersFor, type RuntimeLifecycleDeps } from './runtime-lifecycle';

function deps(reconcileApprovalContinuations: () => Promise<void>): RuntimeLifecycleDeps {
  return {
    cfg: { auditRetentionDays: 0 } as AppConfig,
    configStore: null, stateStore: {} as RuntimeStateStore,
    kbService: null, kbSync: null, toolIndex: null,
    isPaused: () => false, refreshTargets: async () => {},
    kickInhubScheduler() {}, drainInhubScheduler: async () => 0,
    recoverInhubJobs: async () => 0,
    now: () => new Date(0).toISOString(), sleep: async () => {},
    reconcileApprovalContinuations,
  };
}

test('standalone stop preserves unfinished evidence writes across drain timeout and retry', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const firstPass = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  let completed = false;
  const schedulers = startRuntimeSchedulersFor(deps(async () => {
    calls++; started(); await gate; completed = true;
  }));
  t.after(() => { schedulers.stop(); release(); });
  // The scheduler's timer is unref'ed; a bounded guard keeps this test alive.
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([firstPass, new Promise<never>((_, reject) => {
      guard = setTimeout(() => reject(new Error('first evidence pass did not start')), 1_000);
    })]);
  } finally { if (guard) clearTimeout(guard); }
  schedulers.stop();
  assert.equal(await schedulers.drain!(1), false);
  assert.equal(completed, false, 'a timeout must not treat a pending write as drained');
  assert.equal(await schedulers.drain!(1), false, 'a retry still observes the original pending write');
  release();
  assert.equal(await schedulers.drain!(1_000), true);
  assert.equal(completed, true);
  assert.equal(calls, 1);
});

test('standalone stop before the first timer admits no persisted evidence work', async () => {
  let calls = 0;
  const schedulers = startRuntimeSchedulersFor(deps(async () => { calls++; }));
  schedulers.stop();
  await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 0);
  assert.equal(await schedulers.drain!(1), true);
});

test('managed notification maintenance runs on each new owner, throttles ticks and drains an accepted claim', async () => {
  const state = createManagedRuntimeMaintenanceStateV1();
  let time = 100, calls = 0, release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  const dependencies = { ...deps(async () => {}), reconcileNotifications: async () => { calls++; await gate; } };
  const first = createManagedRuntimeMaintenanceFor(dependencies, { nowMs: () => time, state });
  await first.tick(); await first.tick();
  assert.equal(calls, 1);
  assert.equal(await first.stop(1), false);
  release(); assert.equal(await first.stop(1000), true);
  gate = Promise.resolve();
  const second = createManagedRuntimeMaintenanceFor(dependencies, { nowMs: () => time, state });
  await second.tick(); assert.equal(calls, 2, 'new owners recover persisted work on their first existing tick');
  await second.tick(); assert.equal(calls, 2);
  await new Promise<void>(resolve => setImmediate(resolve));
  time += 5000;
  await second.tick(); assert.equal(calls, 3);
  assert.equal(await second.stop(1000), true);
});

test('standalone notification scan starts after listen and remains owned until drained', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const schedulers = startRuntimeSchedulersFor({ ...deps(async () => {}), reconcileNotifications: async () => { entered(); await gate; } });
  const guard = setTimeout(() => {}, 1000);
  try {
    await started; schedulers.stop();
    assert.equal(await schedulers.drain!(1), false);
    release(); assert.equal(await schedulers.drain!(1000), true);
  } finally { clearTimeout(guard); schedulers.stop(); release(); }
});
