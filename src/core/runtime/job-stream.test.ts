import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryJobStreamBroker } from './job-stream';

test('job stream: assigns monotonic ids and replays from cursor', () => {
  let now = 1_000;
  const broker = new InMemoryJobStreamBroker({ now: () => now++ });
  const first = broker.publish('job-1', { type: 'reset', data: { reason: 'model_round', round: 0 } });
  const second = broker.publish('job-1', { type: 'delta', data: { text: 'hello', round: 0 } });

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.deepEqual(broker.read('job-1', 1).events, [second]);
  assert.equal(broker.read('job-1', 2).latestSeq, 2);
});

test('job stream: bounded replay reports a lost cursor', () => {
  const broker = new InMemoryJobStreamBroker({ maxEventsPerJob: 2, maxBytesPerJob: 10_000 });
  broker.publish('job-1', { type: 'delta', data: { text: 'a', round: 0 } });
  broker.publish('job-1', { type: 'delta', data: { text: 'b', round: 0 } });
  broker.publish('job-1', { type: 'delta', data: { text: 'c', round: 0 } });

  const replay = broker.read('job-1', 0);
  assert.equal(replay.truncated, true);
  assert.deepEqual(replay.events.map((event) => event.seq), [2, 3]);
});

test('job stream: waiters wake on publish and seal', async () => {
  const broker = new InMemoryJobStreamBroker();
  const published = broker.waitFor('job-1', 0, 1_000);
  broker.publish('job-1', { type: 'phase', data: { name: 'model', round: 0 } });
  await published;

  const sealed = broker.waitFor('job-1', 1, 1_000);
  broker.seal('job-1');
  await sealed;
});

test('job stream: expires idle replay state without a background timer', () => {
  let now = 10_000;
  const broker = new InMemoryJobStreamBroker({ ttlMs: 100, now: () => now });
  broker.publish('job-1', { type: 'delta', data: { text: 'a', round: 0 } });
  now += 101;
  assert.deepEqual(broker.read('job-1'), { events: [], truncated: false, latestSeq: 0 });
});
