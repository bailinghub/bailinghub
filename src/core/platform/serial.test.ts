// 会话串行道单测：同 key FIFO 非重叠、不同 key 并发、失败不卡后续。零依赖（不碰 runtime/db）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSerial, type SerialLease } from './serial';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('同一 key：任务 FIFO 串行、互不重叠', async () => {
  const order: string[] = [];
  let active = 0; let maxActive = 0;
  const mk = (tag: string, ms: number) => async () => {
    active++; maxActive = Math.max(maxActive, active);
    order.push(`${tag}-start`);
    await sleep(ms);
    order.push(`${tag}-end`);
    active--;
  };
  // 先发的先跑完再轮下一个，即使后发的更快
  const p1 = runSerial('thread:1', mk('A', 30));
  const p2 = runSerial('thread:1', mk('B', 5));
  const p3 = runSerial('thread:1', mk('C', 5));
  await Promise.all([p1, p2, p3]);
  assert.equal(maxActive, 1, '同会话任意时刻只应有 1 个在跑（非重叠）');
  assert.deepEqual(order, ['A-start', 'A-end', 'B-start', 'B-end', 'C-start', 'C-end'], 'FIFO 顺序，A 先完成才轮 B');
});

test('不同 key：并发执行、互不阻塞', async () => {
  let active = 0; let maxActive = 0;
  const mk = () => async () => { active++; maxActive = Math.max(maxActive, active); await sleep(20); active--; };
  await Promise.all([runSerial('thread:10', mk()), runSerial('thread:11', mk()), runSerial('thread:12', mk())]);
  assert.equal(maxActive, 3, '不同会话应能同时在跑');
});

test('某棒失败不卡同 key 的后一棒', async () => {
  const order: string[] = [];
  const p1 = runSerial('thread:2', async () => { order.push('x'); throw new Error('boom'); }).catch(() => order.push('x-caught'));
  const p2 = runSerial('thread:2', async () => { order.push('y'); });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['x', 'x-caught', 'y'], '前一棒抛错后，后一棒仍按序执行');
});

test('无 key：直接执行', async () => {
  let ran = false;
  await runSerial(undefined, async () => { ran = true; });
  assert.equal(ran, true);
});

test('传入 lease：执行前等待租约，结束后释放自己的锁', async () => {
  const calls: string[] = [];
  let attempts = 0;
  const lease: SerialLease = {
    async acquireRuntimeLock(lockKey, owner) {
      calls.push(`acquire:${lockKey}:${owner}`);
      attempts++;
      return attempts >= 3;
    },
    async releaseRuntimeLock(lockKey, owner) {
      calls.push(`release:${lockKey}:${owner}`);
    },
  };

  const got = await runSerial('thread:lease', async () => 'ok', {
    lease,
    owner: 'node-a',
    ttlMs: 10_000,
    retryDelayMs: 1,
    maxWaitMs: 200,
  });

  assert.equal(got, 'ok');
  assert.equal(attempts, 3);
  assert.equal(calls.at(-1), 'release:serial:thread:lease:node-a');
});
