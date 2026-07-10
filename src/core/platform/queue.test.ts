import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from './queue';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('Queue.drain: 等待 running 和 waiting 全部执行完成', async () => {
  const q = new Queue(1);
  const order: string[] = [];
  const first = q.run(async () => { order.push('a:start'); await sleep(20); order.push('a:end'); });
  const second = q.run(async () => { order.push('b:start'); await sleep(5); order.push('b:end'); });

  assert.deepEqual(q.stats(), { running: 1, waiting: 1 });
  assert.equal(await q.drain(200), true);
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
  assert.deepEqual(q.stats(), { running: 0, waiting: 0 });
});

test('Queue.drain: 超时返回 false 且不取消在途任务', async () => {
  const q = new Queue(1);
  let done = false;
  const running = q.run(async () => { await sleep(30); done = true; });

  assert.equal(await q.drain(1), false);
  assert.equal(done, false);
  await running;
  assert.equal(done, true);
});
