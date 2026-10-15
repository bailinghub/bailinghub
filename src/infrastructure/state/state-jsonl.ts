import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { completeTraceEntry } from '../../core/runtime/trace-runtime';
import { JOB_STATUSES, TERMINAL_JOB_STATUSES, type AuditEntry, type Job } from '../../core/contracts/types';
import type { JobOperationalMetricsSnapshot, RuntimeStateStore } from '../../core/state/state-contracts';
import type { ApprovalRequeueInput, ApprovalRequeueOutcome } from '../../core/contracts/approval-continuation';
import { approvalRequeuePlan } from '../../core/state/approval-continuation';
import { deliveryRequeuePlan } from '../../core/state/delivery-replay';
import type { DeliveryRequeueInput, DeliveryRequeueOutcome } from '../../core/contracts/delivery-replay';
import type { NotificationEvent } from '../../core/contracts/notification-outbox';
import { completionMatches, terminalJob, terminalNotifications } from '../../core/state/notification-outbox';
import { JsonlNotificationOutbox } from './notification-outbox-jsonl';

/** jsonl 后端：本地烟测与最小私有部署。状态仍是中枢自己的，不进业务库。 */
export class JsonlStore implements RuntimeStateStore {
  private readonly jobs = new Map<string, Job>();
  private readonly byRequest = new Map<string, string>();
  private readonly locks = new Map<string, { owner: string; expiresAt: number }>();
  private jobWrite: Promise<void> = Promise.resolve();
  private writeFailed = false;
  readonly notificationOutbox = new JsonlNotificationOutbox(work => this.serialJobWrite(work),
    events => this.persistRecord({ kind: 'notification-events', events }));

  private async serialJobWrite<T>(write: () => Promise<T>): Promise<T> {
    const work = this.jobWrite.then(() => {
      if (this.writeFailed) throw new Error('jsonl_journal_reopen_required');
      return write();
    });
    this.jobWrite = work.then(() => undefined, () => undefined);
    return await work;
  }

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) return;
    let bytes = await readFile(this.path);
    // A killed append may leave an incomplete final line. Never concatenate a
    // subsequent record onto that fragment, or silently skip damaged middle data.
    if (bytes.length && bytes[bytes.length - 1] !== 10) {
      const boundary = bytes.lastIndexOf(10) + 1;
      const tail = bytes.subarray(boundary).toString('utf8');
      let complete = false;
      try { JSON.parse(tail); complete = true; } catch { /* incomplete tail */ }
      const file = await open(this.path, 'r+');
      try {
        if (complete) { await file.write(Buffer.from('\n'), 0, 1, bytes.length); bytes = Buffer.concat([bytes, Buffer.from('\n')]); }
        else { await file.truncate(boundary); bytes = bytes.subarray(0, boundary); }
        await file.sync();
      } finally { await file.close(); }
    }
    for (const line of bytes.toString('utf8').split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        const rec = JSON.parse(l) as { kind?: string; job?: Job; notifications?: NotificationEvent[]; events?: NotificationEvent[] };
        if (rec.kind === 'job' && rec.job) {
          this.jobs.set(rec.job.job_id, rec.job);
          this.byRequest.set(rec.job.request_id, rec.job.job_id);
          if (rec.notifications) this.notificationOutbox.publish(rec.notifications);
        }
        if (rec.kind === 'notification-events' && rec.events) this.notificationOutbox.publish(rec.events);
      } catch {
        throw new Error('jsonl_journal_corrupt_record');
      }
    }
  }

  async findByRequestId(requestId: string): Promise<Job | null> {
    const id = this.byRequest.get(requestId);
    return id ? this.jobs.get(id) ?? null : null;
  }

  async createJob(job: Job): Promise<void> {
    await this.serialJobWrite(async () => {
      if (this.jobs.has(job.job_id) || this.byRequest.has(job.request_id)) {
        throw Object.assign(new Error('job_identity_conflict'), { code: 'ER_DUP_ENTRY' });
      }
      await this.persist(job);
      this.jobs.set(job.job_id, job);
      this.byRequest.set(job.request_id, job.job_id);
    });
  }

  async updateJob(jobId: string, patch: Partial<Job>): Promise<Job | null> {
    return await this.serialJobWrite(async () => this.writeJob(jobId, patch));
  }

  async completeJobWithNotifications(original: Job, patch: Partial<Job>, context?: { brandName?: string }): Promise<Job | null> {
    return this.serialJobWrite(async () => {
      if (!terminalJob({ ...original, ...patch }) || !completionMatches(this.jobs.get(original.job_id) ?? null, original)) return null;
      return this.writeJob(original.job_id, patch, undefined, context);
    });
  }

  private async writeJob(jobId: string, patch: Partial<Job>, expectedStatuses?: Array<Job['status']>, context?: { brandName?: string }): Promise<Job | null> {
    const cur = this.jobs.get(jobId);
    if (!cur || (expectedStatuses && !expectedStatuses.includes(cur.status))) return null;
    const { approval_continuation_keys: _ignored, delivery_replay_keys: _ignoredDelivery, ...ordinaryPatch } = patch;
    const next: Job = { ...cur, ...ordinaryPatch, updated_at: new Date().toISOString() };
    const events = terminalNotifications(cur, next, context);
    await this.persist(next, events);
    this.jobs.set(jobId, next);
    this.notificationOutbox.publish(events);
    return next;
  }

  async updateJobIfStatus(jobId: string, expectedStatuses: Array<Job['status']>, patch: Partial<Job>): Promise<Job | null> {
    if (!expectedStatuses.length) return null;
    return await this.serialJobWrite(async () => this.writeJob(jobId, patch, expectedStatuses));
  }

  async requeueApprovedJobOnce(input: ApprovalRequeueInput): Promise<ApprovalRequeueOutcome> {
    return await this.serialJobWrite(async () => {
      const plan = approvalRequeuePlan(this.jobs.get(input.job_id) ?? null, input);
      if (plan.patch) {
        if (!input.isApprovedUnused) return 'conflict';
        if (!await input.isApprovedUnused()) return 'consumed';
        const current = this.jobs.get(input.job_id)!;
        const next = { ...current, ...plan.patch, updated_at: new Date().toISOString() };
        // Publish only after durable append succeeds; failed writes remain retryable.
        await this.persist(next);
        this.jobs.set(input.job_id, next);
      }
      return plan.outcome;
    });
  }

  async getJob(jobId: string): Promise<Job | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async requeueDeliveryJobOnce(input: DeliveryRequeueInput): Promise<DeliveryRequeueOutcome> {
    return await this.serialJobWrite(async () => {
      const plan = deliveryRequeuePlan(this.jobs.get(input.job_id) ?? null, input);
      if (plan.patch) {
        if (!input.isOriginalDelivery || !await input.isOriginalDelivery()) return 'conflict';
        const next = { ...this.jobs.get(input.job_id)!, ...plan.patch, updated_at: new Date().toISOString() };
        await this.persist(next);
        this.jobs.set(input.job_id, next);
      }
      return plan.outcome;
    });
  }

  async claimNextJob(targets: string[], executorId: string, leaseMs: number): Promise<Job | null> {
    if (!targets.length) return null;
    const nowMs = Date.now();
    for (const job of this.jobs.values()) {
      if (this.isClaimable(job, targets, nowMs)) {
        return await this.updateJobIfStatus(job.job_id, ['queued'], {
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
        return await this.updateJobIfStatus(job.job_id, ['queued'], {
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
        if (await this.updateJobIfStatus(job.job_id, ['queued'], { status: 'error', error: '排队超时：执行器长时间不可用，任务已过期（避免恢复后陈旧任务全量重放）' })) n++;
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
    await this.serialJobWrite(() => this.persistRecord({ kind: 'audit', entry: completeTraceEntry(entry) }));
  }

  async pruneAuditOlderThan(_cutoffIso: string): Promise<number> {
    return 0;
  }

  async close(): Promise<void> { await this.jobWrite; }

  private async persist(job: Job, notifications: NotificationEvent[] = []): Promise<void> {
    await this.persistRecord({ kind: 'job', job, ...(notifications.length ? { notifications } : {}) });
  }

  private async persistRecord(record: unknown): Promise<void> {
    try {
      const file = await open(this.path, 'a');
      try { await file.writeFile(JSON.stringify(record) + '\n', 'utf8'); await file.sync(); }
      finally { await file.close(); }
    } catch (error) {
      // A write/sync acknowledgement can be ambiguous. Reopen the journal before
      // accepting another mutation instead of creating a second terminal event.
      this.writeFailed = true;
      throw error;
    }
  }
}
