import assert from 'node:assert/strict';
import test from 'node:test';
import { KernelExecutionQueueV1 } from './execution-gate';

test('KernelExecutionQueueV1 exposes only the process-wide run gate', async () => {
  const gate = new KernelExecutionQueueV1(1);
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.getPrototypeOf(gate)).sort(),
    ['constructor', 'run'],
  );

  let release!: () => void;
  const first = gate.run(() => new Promise<string>((resolve) => {
    release = () => resolve('first');
  }));
  let secondStarted = false;
  const second = gate.run(async () => {
    secondStarted = true;
    return 'second';
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
});
