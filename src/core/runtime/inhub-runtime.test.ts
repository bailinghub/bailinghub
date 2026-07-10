import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInhubRuntime } from './inhub-runtime';
import type { AuditEntry, Job } from '../contracts/types';

function job(id: string, over: Partial<Job> = {}): Job {
  const ts = '2026-07-01T00:00:00.000Z';
  return {
    job_id: id,
    request_id: `req-${id}`,
    status: 'queued',
    target: 'llm',
    profile: 'default',
    project: '',
    source: 'test',
    input_preview: '',
    input: 'input',
    metadata: {},
    created_at: ts,
    updated_at: ts,
    ...over,
  };
}

function mkRuntime(initial: Job[]) {
  const jobs = new Map(initial.map((j) => [j.job_id, j]));
  const audits: AuditEntry[] = [];
  const processed: Array<{ job: Job; fullInput: string }> = [];
  let timerFn: (() => void) | null = null;
  let timerMs = 0;
  const rt = createInhubRuntime({
    store: {
      async updateJob(jobId, patch) {
        const cur = jobs.get(jobId);
        if (!cur) return null;
        const next = { ...cur, ...patch, updated_at: '2026-07-01T00:00:01.000Z' };
        jobs.set(jobId, next);
        return next;
      },
      async updateJobIfStatus(jobId, expectedStatuses, patch) {
        const cur = jobs.get(jobId);
        if (!cur || !expectedStatuses.includes(cur.status)) return null;
        const next = { ...cur, ...patch, updated_at: '2026-07-01T00:00:01.000Z' };
        jobs.set(jobId, next);
        return next;
      },
      async claimNextInhubJob(targets, workerId, leaseMs) {
        for (const cur of jobs.values()) {
          if (cur.status !== 'queued' || !cur.target || !targets.includes(cur.target)) continue;
          if (cur.run_after && new Date(cur.run_after).getTime() > Date.now()) continue;
          const next = {
            ...cur,
            status: 'running' as const,
            executor_id: workerId,
            claim_token: `claim-${cur.job_id}`,
            claimed_at: '2026-07-01T00:00:01.000Z',
            lease_until: new Date(Date.now() + leaseMs).toISOString(),
            run_after: undefined,
            updated_at: '2026-07-01T00:00:01.000Z',
          };
          jobs.set(cur.job_id, next);
          return next;
        }
        return null;
      },
      async listJobsByStatus(statuses, olderThanMs) {
        return [...jobs.values()].filter((j) => statuses.includes(j.status) && (olderThanMs === undefined || j.job_id.includes('stale')));
      },
      async listExpiredLeases(statuses, olderThanMs) {
        const cutoff = Date.now() - olderThanMs;
        return [...jobs.values()].filter((j) => {
          if (!statuses.includes(j.status)) return false;
          if (j.lease_until) return new Date(j.lease_until).getTime() < Date.now();
          return new Date(j.updated_at).getTime() < cutoff || j.job_id.includes('stale');
        });
      },
      async appendAudit(entry) { audits.push(entry); },
    },
    now: () => '2026-07-01T00:00:02.000Z',
    isRemoteExecutorTarget: (target) => target === 'claude-code',
    resolveProjectPath: async (project) => project ? `/repo/${project}` : null,
    runSerial: async (_key, task) => task(),
    processJob: async (j, _route, _projectPath, fullInput) => { processed.push({ job: j, fullInput }); },
    workerId: 'node-a',
    leaseMs: 20 * 60 * 1000,
    inhubTargets: () => ['llm'],
    prepareClaimedJob: async (j) => ({ job: j, route: null, projectPath: null, fullInput: j.input ?? '', session: { sessionId: j.session_id ?? 's1', isContinue: !!j.dispatch?.is_continue } }),
    setTimeoutFn: (fn, ms) => { timerFn = fn; timerMs = ms; return { unref() { /* noop */ } }; },
  });
  return { rt, jobs, audits, processed, timer: () => ({ fn: timerFn, ms: timerMs }) };
}

test('refireJob: 本地任务回 queued、清理认领痕迹与 no_delivery，并唤醒 DB 调度器', async () => {
  const base = job('j1', {
    status: 'running',
    project: 'demo',
    session_id: 's1',
    attempts: 3,
    error: 'boom',
    executor_id: 'ex',
    claim_token: 'claim',
    metadata: { no_delivery: true, keep: 'yes' },
  });
  const { rt, jobs, processed } = mkRuntime([base]);

  const updated = await rt.refireJob(base);

  assert.equal(updated?.status, 'queued');
  assert.equal(updated?.attempts, 0);
  assert.equal(updated?.run_after, undefined);
  assert.equal(updated?.error, undefined);
  assert.equal(updated?.claim_token, undefined);
  assert.deepEqual(updated?.metadata, { keep: 'yes' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.get('j1')?.metadata['no_delivery'], undefined);
  assert.equal(processed.length, 1);
  assert.equal(processed[0]?.job.job_id, 'j1');
  assert.equal(processed[0]?.fullInput, 'input');
});

test('refireJob: 任务状态已被别的实例推进时不倒回 queued', async () => {
  const staleView = job('j-race', { status: 'running' });
  const { rt, jobs, processed } = mkRuntime([
    job('j-race', { status: 'done', result: { text: 'finished' } }),
  ]);

  const updated = await rt.refireJob(staleView);

  assert.equal(updated, null);
  assert.equal(jobs.get('j-race')?.status, 'done');
  assert.equal(processed.length, 0);
});

test('recoverJobs: boot 只恢复 inhub 目标，跳过远端执行器目标', async () => {
  const { rt, audits, processed } = mkRuntime([
    job('local-q', { status: 'queued', target: 'llm' }),
    job('local-r', { status: 'running', target: 'llm' }),
    job('remote-r', { status: 'running', target: 'claude-code' }),
  ]);

  const n = await rt.recoverJobs('boot', 20 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  await rt.drain(5);

  assert.equal(n, 2);
  assert.deepEqual(processed.map((x) => x.job.job_id).sort(), ['local-q', 'local-r']);
  assert.deepEqual(audits.filter((a) => a.event === 'recovered').map((a) => a.event), ['recovered', 'recovered']);
  assert.ok(audits.filter((a) => a.event === 'recovered').every((a) => a.detail['scope'] === 'boot'));
});

test('recoverJobs: stale 只重排 running stale；queued 是否执行交给调度器', async () => {
  const { rt, audits, processed } = mkRuntime([
    job('queued-stale', { status: 'queued', target: 'llm' }),
    job('running-stale', { status: 'running', target: 'llm' }),
  ]);

  const n = await rt.recoverJobs('stale', 20 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  await rt.drain(5);

  assert.equal(n, 1);
  assert.deepEqual(audits.filter((a) => a.event === 'recovered').map((a) => a.detail['prev_status']), ['running']);
  assert.ok(processed.map((x) => x.job.job_id).includes('running-stale'));
});

test('scheduleRetry: 先落 queued+审计，计时到点后才重新执行', async () => {
  const base = job('retry-1', { status: 'running', attempts: 0 });
  const { rt, jobs, audits, processed, timer } = mkRuntime([base]);

  await rt.scheduleRetry(base, null, null, 'retry input', { sessionId: 's1', isContinue: false }, {
    attempt: 1,
    max: 2,
    backoffMs: 123,
    error: 'temporary',
  });

  assert.equal(jobs.get('retry-1')?.status, 'queued');
  assert.equal(jobs.get('retry-1')?.attempts, 1);
  assert.ok(jobs.get('retry-1')?.run_after);
  assert.equal(audits[0]?.event, 'retry_scheduled');
  assert.equal(timer().ms, 123);
  assert.equal(processed.length, 0);

  timer().fn?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processed.length, 0); // run_after 未到，调度器不会提前认领
  const retryJob = jobs.get('retry-1');
  if (retryJob) jobs.set('retry-1', { ...retryJob, run_after: new Date(Date.now() - 1000).toISOString() });
  await rt.drain(1);
  assert.equal(processed.length, 1);
  assert.equal(processed[0]?.job.attempts, 1);
  assert.equal(processed[0]?.fullInput, 'retry input');
});

test('scheduleRetry: 状态已变化时不安排重试计时器', async () => {
  const staleView = job('retry-race', { status: 'running', attempts: 0 });
  const { rt, jobs, audits, processed, timer } = mkRuntime([
    job('retry-race', { status: 'done', attempts: 0 }),
  ]);

  await rt.scheduleRetry(staleView, null, null, 'retry input', { sessionId: 's1', isContinue: false }, {
    attempt: 1,
    max: 2,
    backoffMs: 123,
    error: 'temporary',
  });

  assert.equal(jobs.get('retry-race')?.status, 'done');
  assert.equal(audits.length, 0);
  assert.equal(timer().fn, null);
  assert.equal(processed.length, 0);
});
