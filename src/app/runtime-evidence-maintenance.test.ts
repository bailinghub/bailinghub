import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import { startRuntimeSchedulersFor, type RuntimeLifecycleDeps } from './runtime-lifecycle';

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
