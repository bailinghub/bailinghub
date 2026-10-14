import test from 'node:test';
import assert from 'node:assert/strict';
import { NotificationBackgroundWork, notificationBackgroundWorkFor, bindNotificationBackgroundWork } from './notification-background-work';

test('notification drain includes children accepted during drain and retries a timeout', async () => {
  const work = new NotificationBackgroundWork();
  let releaseParent!: () => void, releaseChild!: () => void;
  const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
  const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
  void work.track('delivery', async () => {
    await parentGate;
    void work.track('delivery-dlq', () => childGate);
  });
  work.beginDrain();
  assert.equal(await work.drain(1), false);
  releaseParent();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(work.snapshot().kinds.find(x => x.kind === 'delivery-dlq')?.inFlight, 1);
  assert.equal(await work.drain(1), false);
  releaseChild();
  assert.equal(await work.drain(100), true);
  assert.equal(work.snapshot().drainTimeouts, 2);
  assert.equal(work.snapshot().kinds.find(x => x.kind === 'delivery-dlq')?.completed, 1);
});

test('notification failure diagnostics expose only fixed kinds and guard outcome predicates', async () => {
  const work = new NotificationBackgroundWork();
  const kinds: string[] = [];
  work.setFailureReporter(kind => { kinds.push(kind); throw new Error('diagnostic sink unavailable'); });
  await assert.rejects(work.track('callback', async () => { throw new Error('private payload'); }));
  assert.equal(await work.track('alert', async () => false, sent => !sent), false);
  assert.equal(await work.track('delivery', async () => true, () => { throw new Error('bad predicate'); }), true);
  assert.equal(await work.drain(100), true);
  assert.deepEqual(kinds, ['callback', 'alert', 'delivery']);
  assert.equal(work.snapshot().kinds.reduce((sum, x) => sum + x.failed, 0), 3);
  assert.equal(JSON.stringify(work.snapshot()).includes('private'), false);
});

test('notification tracking belongs to one store/Kernel and snapshot handles large pending sets', async () => {
  const one = {}, two = {};
  const work = new NotificationBackgroundWork();
  bindNotificationBackgroundWork(one, work);
  assert.equal(notificationBackgroundWorkFor(one), work);
  assert.notEqual(notificationBackgroundWorkFor(two), work);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  for (let i = 0; i < 10000; i++) void work.track('callback', () => gate);
  assert.equal(work.snapshot().kinds.find(x => x.kind === 'callback')?.inFlight, 10000);
  release(); await work.drain(1000);
});
