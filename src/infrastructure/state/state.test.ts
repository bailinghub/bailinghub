// listJobsByStatus 选择谓词单测（零依赖：node:test，jsonl 后端，无需 MySQL）。
// 这是 inhub 崩溃/僵死恢复正确性的命门——选错集合会漏救孤儿，或周期性误捞活任务导致双跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { JsonlStore } from './state-jsonl';
import type { Job } from '../../core/contracts/types';

function mkJob(id: string, status: Job['status'], updatedAtIso: string): Job {
  return {
    job_id: id, request_id: 'req-' + id, status,
    profile: 'readonly', project: '', source: 'test',
    input_preview: '', metadata: {},
    created_at: updatedAtIso, updated_at: updatedAtIso,
  };
}

async function freshStore(tag: string): Promise<{ store: JsonlStore; path: string }> {
  const path = join(tmpdir(), `bz-state-test-${tag}-${process.pid}-${Date.now()}.jsonl`);
  const store = new JsonlStore(path);
  await store.init();
  return { store, path };
}

test('listJobsByStatus(boot): 取全部 queued+running，排除终态(done/error)与 dispatched', async () => {
  const { store, path } = await freshStore('boot');
  try {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    await store.createJob(mkJob('q1', 'queued', old));
    await store.createJob(mkJob('r1', 'running', fresh));
    await store.createJob(mkJob('d1', 'done', old));
    await store.createJob(mkJob('e1', 'error', old));
    await store.createJob(mkJob('disp1', 'dispatched', old)); // 执行器任务，不归 inhub 恢复管
    const got = (await store.listJobsByStatus(['queued', 'running'])).map((j) => j.job_id).sort();
    assert.deepEqual(got, ['q1', 'r1']);
  } finally { await rm(path, { force: true }); }
});

test('listJobsByStatus(stale): 只取 running 且 updated_at 早于阈值，不误捞新近运行的任务', async () => {
  const { store, path } = await freshStore('stale');
  try {
    const stale = new Date(Date.now() - 25 * 60 * 1000).toISOString(); // 25 分钟前
    const fresh = new Date().toISOString();
    await store.createJob(mkJob('run-stale', 'running', stale));
    await store.createJob(mkJob('run-fresh', 'running', fresh));
    const got = (await store.listJobsByStatus(['running'], 20 * 60 * 1000)).map((j) => j.job_id);
    assert.deepEqual(got, ['run-stale']); // 仅僵死的；新近运行的合法长任务不动
  } finally { await rm(path, { force: true }); }
});

test('listJobsByStatus(stale): 周期扫描只传 running，queued 永不入选（不碰活计时器，防双跑）', async () => {
  const { store, path } = await freshStore('queued-safe');
  try {
    const stale = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    await store.createJob(mkJob('queued-old', 'queued', stale)); // 即便很旧，stale 扫描(statuses=['running'])也不该选它
    const got = await store.listJobsByStatus(['running'], 20 * 60 * 1000);
    assert.deepEqual(got, []);
  } finally { await rm(path, { force: true }); }
});

test('listJobsByStatus: 空状态数组返回空', async () => {
  const { store, path } = await freshStore('empty');
  try {
    await store.createJob(mkJob('r1', 'running', new Date().toISOString()));
    assert.deepEqual(await store.listJobsByStatus([]), []);
  } finally { await rm(path, { force: true }); }
});

test('updateJob: 持久化运行期字段并支持清空认领凭证', async () => {
  const { store, path } = await freshStore('update-runtime-fields');
  try {
    const ts = new Date().toISOString();
    await store.createJob({
      ...mkJob('u1', 'queued', ts),
      target: 'llm',
      input: 'raw',
      dispatch: { target_config: { model: 'm1' }, is_continue: false },
    });
    const dispatchedAt = new Date(Date.now() - 1000).toISOString();
    await store.updateJob('u1', {
      status: 'dispatched',
      input: 'assembled',
      dispatch: { target_config: { model: 'm2' }, kb_refs: [{ seq: 1, doc_id: 9, title: 'doc', score: 0.8, snippet: 'hit' }] },
      executor_id: 'ex-1',
      claimed_at: dispatchedAt,
      lease_until: new Date(Date.now() + 60_000).toISOString(),
      dispatched_at: dispatchedAt,
      claim_token: 'claim-1',
    });
    await store.updateJob('u1', { status: 'done', claim_token: undefined, executor_id: undefined, claimed_at: undefined, lease_until: undefined, dispatched_at: undefined });

    const reloaded = new JsonlStore(path);
    await reloaded.init();
    const got = await reloaded.getJob('u1');
    assert.equal(got?.status, 'done');
    assert.equal(got?.input, 'assembled');
    assert.equal(got?.dispatch?.target_config?.model, 'm2');
    assert.equal(got?.dispatch?.kb_refs?.[0]?.doc_id, 9);
    assert.equal(got?.claim_token, undefined);
    assert.equal(got?.executor_id, undefined);
    assert.equal(got?.claimed_at, undefined);
    assert.equal(got?.lease_until, undefined);
    assert.equal(got?.dispatched_at, undefined);
  } finally { await rm(path, { force: true }); }
});

test('updateJobIfStatus: 状态匹配才更新，状态已推进时返回 null 且不倒回', async () => {
  const { store, path } = await freshStore('conditional-update');
  try {
    const ts = new Date().toISOString();
    await store.createJob(mkJob('cond-1', 'queued', ts));

    const claimed = await store.updateJobIfStatus('cond-1', ['queued'], { status: 'running', attempts: 1 });
    assert.equal(claimed?.status, 'running');
    assert.equal(claimed?.attempts, 1);

    const stale = await store.updateJobIfStatus('cond-1', ['queued'], { status: 'running', attempts: 2 });
    assert.equal(stale, null);
    const got = await store.getJob('cond-1');
    assert.equal(got?.status, 'running');
    assert.equal(got?.attempts, 1);
  } finally { await rm(path, { force: true }); }
});

test('updateJobIfStatus: 空 expectedStatuses 不更新', async () => {
  const { store, path } = await freshStore('conditional-empty');
  try {
    const ts = new Date().toISOString();
    await store.createJob(mkJob('cond-empty', 'queued', ts));

    const got = await store.updateJobIfStatus('cond-empty', [], { status: 'running' });

    assert.equal(got, null);
    assert.equal((await store.getJob('cond-empty'))?.status, 'queued');
  } finally { await rm(path, { force: true }); }
});

test('claimNextInhubJob: 尊重 run_after，到期后原子转 running', async () => {
  const { store, path } = await freshStore('claim-inhub-run-after');
  try {
    const ts = new Date().toISOString();
    await store.createJob({
      ...mkJob('future', 'queued', ts),
      target: 'llm',
      run_after: new Date(Date.now() + 60_000).toISOString(),
    });
    await store.createJob({
      ...mkJob('ready', 'queued', ts),
      target: 'llm',
      run_after: new Date(Date.now() - 1000).toISOString(),
    });

    const claimed = await store.claimNextInhubJob(['llm'], 'inhub-node-a', 60_000);

    assert.equal(claimed?.job_id, 'ready');
    assert.equal(claimed?.status, 'running');
    assert.equal(claimed?.executor_id, 'inhub-node-a');
    assert.ok(claimed?.claimed_at);
    assert.ok(claimed?.lease_until);
    assert.equal(claimed?.run_after, undefined);
    assert.equal((await store.getJob('future'))?.status, 'queued');
  } finally { await rm(path, { force: true }); }
});

test('claimNextJob: 执行器认领同样跳过未到 run_after 的 queued 任务', async () => {
  const { store, path } = await freshStore('claim-executor-run-after');
  try {
    const ts = new Date().toISOString();
    await store.createJob({
      ...mkJob('remote-future', 'queued', ts),
      target: 'remote-agent',
      run_after: new Date(Date.now() + 60_000).toISOString(),
    });

    assert.equal(await store.claimNextJob(['remote-agent'], 'executor-a', 60_000), null);

    await store.updateJob('remote-future', { run_after: new Date(Date.now() - 1000).toISOString() });
    const claimed = await store.claimNextJob(['remote-agent'], 'executor-a', 60_000);
    assert.equal(claimed?.status, 'dispatched');
    assert.equal(claimed?.executor_id, 'executor-a');
    assert.ok(claimed?.claimed_at);
    assert.ok(claimed?.lease_until);
    assert.equal(claimed?.run_after, undefined);
  } finally { await rm(path, { force: true }); }
});

test('claimNextJob: 同 thread 已有在途任务时不认领后续任务', async () => {
  const { store, path } = await freshStore('claim-thread-inflight');
  try {
    const ts = new Date().toISOString();
    await store.createJob({ ...mkJob('running', 'running', ts), target: 'remote-agent', thread_id: 7 });
    await store.createJob({ ...mkJob('next', 'queued', ts), target: 'remote-agent', thread_id: 7 });

    assert.equal(await store.claimNextJob(['remote-agent'], 'executor-a', 60_000), null);

    await store.updateJob('running', { status: 'done' });
    const claimed = await store.claimNextJob(['remote-agent'], 'executor-a', 60_000);
    assert.equal(claimed?.job_id, 'next');
  } finally { await rm(path, { force: true }); }
});

test('claimNextJob: 同 thread 严格按 queued 队头认领', async () => {
  const { store, path } = await freshStore('claim-thread-head');
  try {
    const early = new Date(Date.now() - 2000).toISOString();
    const late = new Date(Date.now() - 1000).toISOString();
    await store.createJob({ ...mkJob('first', 'queued', early), target: 'remote-agent', thread_id: 8 });
    await store.createJob({ ...mkJob('second', 'queued', late), target: 'remote-agent', thread_id: 8 });

    const claimed = await store.claimNextJob(['remote-agent'], 'executor-a', 60_000);
    assert.equal(claimed?.job_id, 'first');
    assert.equal(await store.claimNextJob(['remote-agent'], 'executor-b', 60_000), null);
  } finally { await rm(path, { force: true }); }
});

test('extendExecutorLeases: 心跳续租执行器名下 dispatched 任务', async () => {
  const { store, path } = await freshStore('extend-executor-leases');
  try {
    const ts = new Date().toISOString();
    await store.createJob({ ...mkJob('j1', 'queued', ts), target: 'remote-agent' });
    const claimed = await store.claimNextJob(['remote-agent'], 'executor-a', 10);
    assert.ok(claimed?.lease_until);
    await new Promise((resolve) => setTimeout(resolve, 15));

    const n = await store.extendExecutorLeases('executor-a', 60_000);
    const got = await store.getJob('j1');
    assert.equal(n, 1);
    assert.equal(got?.status, 'dispatched');
    assert.ok(new Date(got?.lease_until ?? '').getTime() > Date.now());
  } finally { await rm(path, { force: true }); }
});

test('requeueStaleDispatched: lease 过期后回 queued 并清理认领字段', async () => {
  const { store, path } = await freshStore('requeue-expired-lease');
  try {
    const ts = new Date().toISOString();
    await store.createJob({
      ...mkJob('expired', 'dispatched', ts),
      target: 'remote-agent',
      executor_id: 'executor-a',
      claim_token: 'claim',
      claimed_at: new Date(Date.now() - 120_000).toISOString(),
      lease_until: new Date(Date.now() - 1000).toISOString(),
      dispatched_at: new Date(Date.now() - 120_000).toISOString(),
    });

    assert.equal(await store.requeueStaleDispatched(60_000, 60 * 60_000), 1);
    const got = await store.getJob('expired');
    assert.equal(got?.status, 'queued');
    assert.equal(got?.executor_id, undefined);
    assert.equal(got?.claim_token, undefined);
    assert.equal(got?.claimed_at, undefined);
    assert.equal(got?.lease_until, undefined);
    assert.equal(got?.dispatched_at, undefined);
  } finally { await rm(path, { force: true }); }
});

test('listExpiredLeases: 只返回租约过期或缺少租约且超过硬时限的任务', async () => {
  const { store, path } = await freshStore('list-expired-leases');
  try {
    const old = new Date(Date.now() - 25 * 60_000).toISOString();
    const fresh = new Date().toISOString();
    await store.createJob({ ...mkJob('lease-expired', 'running', fresh), lease_until: new Date(Date.now() - 1000).toISOString() });
    await store.createJob({ ...mkJob('lease-fresh', 'running', old), lease_until: new Date(Date.now() + 60_000).toISOString() });
    await store.createJob({ ...mkJob('legacy-old', 'running', old) });

    const got = (await store.listExpiredLeases(['running'], 20 * 60_000)).map((j) => j.job_id).sort();
    assert.deepEqual(got, ['lease-expired', 'legacy-old']);
  } finally { await rm(path, { force: true }); }
});

test('runtime lock: 同 owner 可续租，其他 owner 等过期或释放后才能抢占', async () => {
  const { store, path } = await freshStore('runtime-lock');
  try {
    assert.equal(await store.acquireRuntimeLock('serial:1', 'owner-a', 50), true);
    assert.equal(await store.acquireRuntimeLock('serial:1', 'owner-b', 50), false);
    assert.equal(await store.acquireRuntimeLock('serial:1', 'owner-a', 50), true);

    await store.releaseRuntimeLock('serial:1', 'owner-b');
    assert.equal(await store.acquireRuntimeLock('serial:1', 'owner-b', 50), false);

    await store.releaseRuntimeLock('serial:1', 'owner-a');
    assert.equal(await store.acquireRuntimeLock('serial:1', 'owner-b', 50), true);
  } finally { await rm(path, { force: true }); }
});

test('runtime lock: 租约过期后可被新 owner 抢占', async () => {
  const { store, path } = await freshStore('runtime-lock-expire');
  try {
    assert.equal(await store.acquireRuntimeLock('serial:2', 'owner-a', 5), true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(await store.acquireRuntimeLock('serial:2', 'owner-b', 50), true);
    await store.releaseRuntimeLock('serial:2', 'owner-b');
  } finally { await rm(path, { force: true }); }
});

test('appendAudit: 写入时固化结构化 trace 字段', async () => {
  const { store, path } = await freshStore('audit-trace-shape');
  try {
    await store.appendAudit({
      ts: '2026-07-01T00:00:00.000Z',
      job_id: 'job-audit',
      request_id: 'req-audit',
      event: 'tool_result',
      detail: { tool: 'order.get', status: 200, duration_ms: 42 },
    });

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    const rec = JSON.parse(lines[0]!) as { kind: string; entry: Record<string, unknown> };
    assert.equal(rec.kind, 'audit');
    assert.equal(rec.entry['stage'], 'tool');
    assert.equal(rec.entry['severity'], 'info');
    assert.equal(rec.entry['title'], '工具结果');
    assert.equal(rec.entry['summary'], 'order.get · HTTP 200 · 42ms');
  } finally { await rm(path, { force: true }); }
});
