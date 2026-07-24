import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { completeTraceEntry } from '../../core/runtime/trace-runtime';
import { JOB_STATUSES, TERMINAL_JOB_STATUSES, type AuditEntry, type Job } from '../../core/contracts/types';
import type { JobOperationalMetricsSnapshot, RuntimeStateStore } from '../../core/state/state-contracts';

/** jsonl 后端：本地烟测与最小私有部署。状态仍是中枢自己的，不进业务库。 */
export class JsonlStore implements RuntimeStateStore {
  private readonly jobs = new Map<string, Job>();
  private readonly byRequest = new Map<string, string>();
  private readonly locks = new Map<string, { owner: string; expiresAt: number }>();

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) return;
    const text = await readFile(this.path, 'utf8');
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        const rec = JSON.parse(l) as { kind?: string; job?: Job };
        if (rec.kind === 'job' && rec.job) {
          this.jobs.set(rec.job.job_id, rec.job);
          this.byRequest.set(rec.job.request_id, rec.job.job_id);
        }
      } catch {
        /* 跳过坏行 */
      }
    }
  }

  async findByRequestId(requestId: string): Promise<Job | null> {
    const id = this.byRequest.get(requestId);
    return id ? this.jobs.get(id) ?? null : null;
  }

  async createJob(job: Job): Promise<void> {
    this.jobs.set(job.job_id, job);
    this.byRequest.set(job.request_id, job.job_id);
    await this.persist(job);
  }

  async updateJob(jobId: string, patch: Partial<Job>): Promise<Job | null> {
    const cur = this.jobs.get(jobId);
    if (!cur) return null;
    const next: Job = { ...cur, ...patch, updated_at: new Date().toISOString() };
    this.jobs.set(jobId, next);
    await this.persist(next);
    return next;
  }

  async updateJobIfStatus(jobId: string, expectedStatuses: Array<Job['status']>, patch: Partial<Job>): Promise<Job | null> {
    if (!expectedStatuses.length) return null;
    const cur = this.jobs.get(jobId);
    if (!cur || !expectedStatuses.includes(cur.status)) return null;
    return this.updateJob(jobId, patch);
  }

  async getJob(jobId: string): Promise<Job | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async claimNextJob(targets: string[], executorId: string, leaseMs: number): Promise<Job | null> {
    if (!targets.length) return null;
    const nowMs = Date.now();
    for (const job of this.jobs.values()) {
      if (this.isClaimable(job, targets, nowMs)) {
        return await this.updateJob(job.job_id, {
          status: 'dispatched',
          executor_id: executorId,
          claimed_at: new Date(nowMs).toISOString(),
          dispatched_at: new Date(nowMs).toISOString(),
          lease_until: new Date(nowMs + Math.max(1, leaseMs)).toISOString(),
          claim_token: randomUUID(),
          run_after: undefined,
        });
      }
    }
    return null;
  }

  async claimNextInhubJob(targets: string[], workerId: string, leaseMs: number): Promise<Job | null> {
    if (!targets.length) return null;
    const nowMs = Date.now();
    for (const job of this.jobs.values()) {
      if (this.isClaimable(job, targets, nowMs)) {
        return await this.updateJob(job.job_id, {
          status: 'running',
          executor_id: workerId,
          claimed_at: new Date(nowMs).toISOString(),
          lease_until: new Date(nowMs + Math.max(1, leaseMs)).toISOString(),
          claim_token: randomUUID(),
          run_after: undefined,
        });
      }
    }
    return null;
  }

  private isClaimable(job: Job, targets: string[], nowMs: number): boolean {
    if (job.status !== 'queued' || !job.target || !targets.includes(job.target)) return false;
    if (job.run_after && new Date(job.run_after).getTime() > nowMs) return false;
    if (job.thread_id === undefined) return true;
    for (const other of this.jobs.values()) {
      if (other.job_id === job.job_id || other.thread_id !== job.thread_id) continue;
      if (other.status === 'running' || other.status === 'dispatched') return false;
      if (other.status !== 'queued') continue;
      if (other.run_after && new Date(other.run_after).getTime() > nowMs) continue;
      if (other.created_at < job.created_at || (other.created_at === job.created_at && other.job_id < job.job_id)) return false;
    }
    return true;
  }

  async extendExecutorLeases(executorId: string, leaseMs: number): Promise<number> {
    const nowMs = Date.now();
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== 'dispatched' || job.executor_id !== executorId) continue;
      await this.updateJob(job.job_id, { lease_until: new Date(nowMs + Math.max(1, leaseMs)).toISOString() });
      n++;
    }
    return n;
  }

  async requeueStaleDispatched(_deadAfterMs: number, hardCapMs: number): Promise<number> {
    const nowMs = Date.now();
    const cutoff = nowMs - hardCapMs;
    let n = 0;
    for (const job of this.jobs.values()) {
      const leaseExpired = job.lease_until && new Date(job.lease_until).getTime() < nowMs;
      const hardExpired = job.dispatched_at && new Date(job.dispatched_at).getTime() < cutoff;
      if (job.status === 'dispatched' && (leaseExpired || hardExpired)) {
        await this.updateJob(job.job_id, { status: 'queued', executor_id: undefined, claim_token: undefined, claimed_at: undefined, lease_until: undefined, dispatched_at: undefined });
        n++;
      }
    }
    return n;
  }

  async listJobsByStatus(statuses: Array<Job['status']>, olderThanMs?: number): Promise<Job[]> {
    if (!statuses.length) return [];
    const cutoff = olderThanMs !== undefined ? Date.now() - olderThanMs : null;
    const out: Job[] = [];
    for (const job of this.jobs.values()) {
      if (!statuses.includes(job.status)) continue;
      if (cutoff !== null && !(job.updated_at && new Date(job.updated_at).getTime() < cutoff)) continue;
      out.push(job);
    }
    return out;
  }

  async listExpiredLeases(statuses: Array<Job['status']>, fallbackOlderThanMs: number): Promise<Job[]> {
    if (!statuses.length) return [];
    const nowMs = Date.now();
    const cutoff = nowMs - fallbackOlderThanMs;
    const out: Job[] = [];
    for (const job of this.jobs.values()) {
      if (!statuses.includes(job.status)) continue;
      const leaseExpired = job.lease_until ? new Date(job.lease_until).getTime() < nowMs : false;
      const oldWithoutLease = !job.lease_until && job.updated_at && new Date(job.updated_at).getTime() < cutoff;
      if (leaseExpired || oldWithoutLease) out.push(job);
    }
    return out;
  }

  async expireStaleQueued(ttlMs: number): Promise<number> {
    const cutoff = Date.now() - ttlMs;
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' && job.created_at && new Date(job.created_at).getTime() < cutoff) {
        await this.updateJob(job.job_id, { status: 'error', error: '排队超时：执行器长时间不可用，任务已过期（避免恢复后陈旧任务全量重放）' });
        n++;
      }
    }
    return n;
  }

  async countInflightByThread(threadId: number): Promise<number> {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.thread_id === threadId && (job.status === 'queued' || job.status === 'running' || job.status === 'dispatched')) n++;
    }
    return n;
  }

  async operationalMetricsSnapshot(nowMs = Date.now()): Promise<JobOperationalMetricsSnapshot> {
    const byStatus = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as JobOperationalMetricsSnapshot['byStatus'];
    const terminalLast15m: JobOperationalMetricsSnapshot['terminalLast15m'] = { done: 0, error: 0, rejected: 0 };
    const terminalCutoffMs = nowMs - 15 * 60_000;
    const queuedThreads = new Set<number>();
    const inflightThreads = new Set<number>();
    let oldestQueuedMs: number | null = null;
    let delayedQueuedJobs = 0;
    let expiredLeases = 0;

    for (const job of this.jobs.values()) {
      byStatus[job.status] += 1;

      const updatedMs = Date.parse(job.updated_at);
      if (TERMINAL_JOB_STATUSES.includes(job.status as (typeof TERMINAL_JOB_STATUSES)[number])
        && Number.isFinite(updatedMs) && updatedMs >= terminalCutoffMs) {
        terminalLast15m[job.status as keyof typeof terminalLast15m] += 1;
      }

      if (job.status === 'queued') {
        if (job.thread_id !== undefined) queuedThreads.add(job.thread_id);
        const runAfterMs = job.run_after ? Date.parse(job.run_after) : Number.NaN;
        if (Number.isFinite(runAfterMs) && runAfterMs > nowMs) delayedQueuedJobs += 1;
        if (job.source !== 'monitor') {
          const createdMs = Date.parse(job.created_at);
          if (Number.isFinite(createdMs) && (oldestQueuedMs === null || createdMs < oldestQueuedMs)) {
            oldestQueuedMs = createdMs;
          }
        }
      }

      if ((job.status === 'running' || job.status === 'dispatched') && job.thread_id !== undefined) {
        inflightThreads.add(job.thread_id);
      }
      if ((job.status === 'running' || job.status === 'dispatched') && job.lease_until) {
        const leaseUntilMs = Date.parse(job.lease_until);
        if (Number.isFinite(leaseUntilMs) && leaseUntilMs < nowMs) expiredLeases += 1;
      }
    }

    let blockedThreads = 0;
    for (const threadId of queuedThreads) {
      if (inflightThreads.has(threadId)) blockedThreads += 1;
    }
    return {
      byStatus,
      terminalLast15m,
      oldestQueuedAgeSeconds: oldestQueuedMs === null ? 0 : Math.max((nowMs - oldestQueuedMs) / 1000, 0),
      delayedQueuedJobs,
      expiredLeases,
      blockedThreads,
    };
  }

  async acquireRuntimeLock(lockKey: string, owner: string, ttlMs: number): Promise<boolean> {
    const nowMs = Date.now();
    const cur = this.locks.get(lockKey);
    if (cur && cur.owner !== owner && cur.expiresAt > nowMs) return false;
    this.locks.set(lockKey, { owner, expiresAt: nowMs + Math.max(1, ttlMs) });
    return true;
  }

  async releaseRuntimeLock(lockKey: string, owner: string): Promise<void> {
    const cur = this.locks.get(lockKey);
    if (cur?.owner === owner) this.locks.delete(lockKey);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    await appendFile(this.path, JSON.stringify({ kind: 'audit', entry: completeTraceEntry(entry) }) + '\n', 'utf8');
  }

  async pruneAuditOlderThan(_cutoffIso: string): Promise<number> {
    return 0;
  }

  private async persist(job: Job): Promise<void> {
    await appendFile(this.path, JSON.stringify({ kind: 'job', job }) + '\n', 'utf8');
  }
}
