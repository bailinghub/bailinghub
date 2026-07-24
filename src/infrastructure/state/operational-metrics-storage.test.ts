import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../../core/config/config';
import type { Job } from '../../core/contracts/types';
import { ObservabilityLedger } from '../config/config-observability-ledger';
import { JsonlStore } from './state-jsonl';
import { MysqlStore } from './state-mysql';

const NOW = Date.parse('2026-07-24T08:00:00.000Z');

function job(input: Partial<Job> & Pick<Job, 'job_id' | 'status'>): Job {
  return {
    request_id: `req-${input.job_id}`,
    profile: 'readonly',
    project: 'demo',
    source: 'test',
    input_preview: 'test',
    metadata: {},
    created_at: '2026-07-24T07:59:30.000Z',
    updated_at: '2026-07-24T07:59:30.000Z',
    ...input,
  };
}

test('JSONL operational snapshot: aggregates lifecycle, queue and lease health without exposing records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bailing-metrics-jsonl-'));
  try {
    const store = new JsonlStore(join(root, 'jobs.jsonl'));
    await store.init();
    await store.createJob(job({
      job_id: 'queued',
      status: 'queued',
      thread_id: 7,
      run_after: '2026-07-24T08:01:00.000Z',
    }));
    await store.createJob(job({
      job_id: 'monitor',
      status: 'queued',
      source: 'monitor',
      created_at: '2026-07-23T00:00:00.000Z',
    }));
    await store.createJob(job({
      job_id: 'running',
      status: 'running',
      thread_id: 7,
      lease_until: '2026-07-24T07:59:59.000Z',
    }));
    await store.createJob(job({ job_id: 'done', status: 'done', updated_at: '2026-07-24T07:55:00.000Z' }));
    await store.createJob(job({ job_id: 'error', status: 'error', updated_at: '2026-07-24T07:30:00.000Z' }));
    await store.createJob(job({ job_id: 'rejected', status: 'rejected', updated_at: '2026-07-24T07:59:00.000Z' }));

    const snapshot = await store.operationalMetricsSnapshot(NOW);
    assert.deepEqual(snapshot.byStatus, { queued: 2, running: 1, dispatched: 0, done: 1, error: 1, rejected: 1 });
    assert.deepEqual(snapshot.terminalLast15m, { done: 1, error: 0, rejected: 1 });
    assert.equal(snapshot.oldestQueuedAgeSeconds, 30);
    assert.equal(snapshot.delayedQueuedJobs, 1);
    assert.equal(snapshot.expiredLeases, 1);
    assert.equal(snapshot.blockedThreads, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MySQL operational snapshot: uses one aggregate query and maps the result', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const store = new MysqlStore({} as AppConfig['state']['mysql']);
  Reflect.set(store, 'pool', {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return [[{
        queued: 2, running: 1, dispatched: 3, done: 4, error: 5, rejected: 6,
        done_15m: 2, error_15m: 1, rejected_15m: 0,
        oldest_queued_at: '2026-07-24T07:59:30.000Z',
        delayed_queued: 1, expired_leases: 2, blocked_threads: 3,
      }], []];
    },
  });

  const snapshot = await store.operationalMetricsSnapshot(NOW);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /COUNT\(DISTINCT q\.thread_id\)/);
  assert.equal(calls[0]!.params.length, 5);
  assert.deepEqual(snapshot.byStatus, { queued: 2, running: 1, dispatched: 3, done: 4, error: 5, rejected: 6 });
  assert.deepEqual(snapshot.terminalLast15m, { done: 2, error: 1, rejected: 0 });
  assert.equal(snapshot.oldestQueuedAgeSeconds, 30);
  assert.equal(snapshot.blockedThreads, 3);
});

test('control-plane operational snapshot: counts approvals and executor heartbeat states in one query', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const ledger = new ObservabilityLedger(() => ({
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return [[{ pending_approvals: 4, executors_online: 2, executors_offline: 5 }], []];
    },
  }));

  const snapshot = await ledger.operationalMetricsSnapshot(NOW);
  assert.deepEqual(snapshot, { pendingApprovals: 4, executorsOnline: 2, executorsOffline: 5 });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /bz_tool_approvals/);
  assert.match(calls[0]!.sql, /bz_executors/);
  assert.equal(calls[0]!.params.length, 2);
});
