import assert from 'node:assert/strict';
import test from 'node:test';
import { UsageBackgroundWork } from './background-work';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function gate() {
  const value = deferred<void>();
  return { promise: value.promise, release: () => value.resolve(undefined) };
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('usage work is already in flight when its factory first runs', async (t) => {
  const owner = new UsageBackgroundWork(), held = gate(), observed = deferred<boolean>();
  t.after(() => held.release());
  const task = owner.track('model-completion', async () => {
    // This is observed from inside the factory, not from private tracker state.
    observed.resolve(await owner.drain(0));
    await held.promise;
  });
  assert.equal(await observed.promise, false);
  held.release();
  await task;
  assert.equal(await owner.drain(100), true);
});

test('drain waits for a late child even when the original snapshot parent does not await it', async (t) => {
  const owner = new UsageBackgroundWork(), parentGate = gate(), childGate = gate();
  const childEntered = deferred<void>();
  t.after(() => { parentGate.release(); childGate.release(); });
  let child: Promise<void> | undefined;
  const parent = owner.track('model-completion', async () => {
    await parentGate.promise;
    child = owner.track('settlement', async () => {
      childEntered.resolve(undefined);
      await childGate.promise;
    });
    // Intentionally finish this parent: a one-snapshot drain would return early.
  });
  owner.beginDrain();
  let drainReturned = false;
  const drained = owner.drain(2000).then(result => { drainReturned = true; return result; });
  parentGate.release();
  await parent;
  await childEntered.promise;
  await turn();
  assert.equal(drainReturned, false);
  assert.equal(await owner.drain(0), false);
  childGate.release();
  assert.ok(child);
  await child;
  assert.equal(await drained, true);
});

test('beginDrain rejects future maintenance before its factory can perform side effects', async () => {
  const owner = new UsageBackgroundWork();
  let acceptedEffects = 0, rejectedEffects = 0;
  const accepted = owner.startMaintenance('response-cleanup', async () => { acceptedEffects++; });
  assert.ok(accepted);
  owner.beginDrain();
  assert.equal(owner.acceptingRequests, false);
  for (const kind of ['response-cleanup', 'usage-reconciliation', 'reference-price-refresh'] as const) {
    assert.equal(owner.startMaintenance(kind, async () => { rejectedEffects++; }), null);
  }
  await accepted;
  await turn();
  assert.equal(acceptedEffects, 1); // Previously accepted maintenance is not cancelled.
  assert.equal(rejectedEffects, 0);
  assert.equal(await owner.drain(0), true);
  assert.equal(owner.acceptingRequests, false);
});

test('zero budget and a timed-out drain retain accepted work for a same-owner retry', async (t) => {
  const owner = new UsageBackgroundWork(), held = gate(), entered = deferred<void>();
  t.after(() => held.release());
  let starts = 0, completed = 0;
  const task = owner.track('model-completion', async () => {
    starts++;
    entered.resolve(undefined);
    await held.promise;
    completed++;
  });
  await entered.promise;
  owner.beginDrain();
  assert.equal(await owner.drain(0), false);
  assert.equal(await owner.drain(10), false);
  assert.equal(starts, 1);
  assert.equal(completed, 0);
  assert.equal(owner.acceptingRequests, false);
  assert.equal(owner.startMaintenance('usage-reconciliation', async () => { completed += 100; }), null);
  held.release();
  await task;
  assert.equal(await owner.drain(100), true);
  assert.equal(starts, 1);
  assert.equal(completed, 1);
  assert.equal(owner.acceptingRequests, false);
});

test('two owners isolate admission and drain; one pending completion cannot hold the other', async (t) => {
  const one = new UsageBackgroundWork(), two = new UsageBackgroundWork(), held = gate();
  t.after(() => held.release());
  let oneCompleted = false, twoCompleted = false;
  const pending = one.track('model-completion', async () => { await held.promise; oneCompleted = true; });
  one.beginDrain();
  assert.equal(two.acceptingRequests, true);
  const independent = two.startMaintenance('usage-reconciliation', async () => { twoCompleted = true; });
  assert.ok(independent);
  two.beginDrain();
  assert.equal(await two.drain(100), true);
  assert.equal(twoCompleted, true);
  assert.equal(oneCompleted, false);
  assert.equal(await one.drain(0), false);
  held.release();
  await pending;
  assert.equal(await one.drain(100), true);
  assert.equal(oneCompleted, true);
});

test('rejected work is drained and reported using only its fixed kind', async () => {
  const owner = new UsageBackgroundWork(), reported: unknown[][] = [];
  owner.setFailureReporter((...args: unknown[]) => { reported.push(args); });
  const failed = owner.track('settlement', async () => {
    throw new Error('Synthetic provider body must not enter lifecycle diagnostics');
  });
  owner.beginDrain();
  await assert.rejects(failed, { message: 'Synthetic provider body must not enter lifecycle diagnostics' });
  assert.equal(await owner.drain(100), true);
  assert.deepEqual(reported, [['settlement']]);
  assert.equal(await owner.drain(0), true);
});

test('a throwing failure reporter cannot keep rejected work live or replace its failure', async () => {
  const owner = new UsageBackgroundWork();
  owner.setFailureReporter(() => { throw new Error('Synthetic diagnostic sink failure'); });
  const failed = owner.track('usage-reconciliation', async () => { throw new Error('Synthetic original work failure'); });
  await assert.rejects(failed, { message: 'Synthetic original work failure' });
  owner.beginDrain();
  assert.equal(await owner.drain(100), true);
});
