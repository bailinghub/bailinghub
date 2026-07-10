import type { AuditEntry, Job } from '../contracts/types';

export interface JobRepository {
  findByRequestId(requestId: string): Promise<Job | null>;
  createJob(job: Job): Promise<void>;
  updateJob(jobId: string, patch: Partial<Job>): Promise<Job | null>;
  /** 条件更新：仅当当前状态仍在 expectedStatuses 内才应用 patch；状态已被别的实例推进时返回 null。 */
  updateJobIfStatus(jobId: string, expectedStatuses: Array<Job['status']>, patch: Partial<Job>): Promise<Job | null>;
  getJob(jobId: string): Promise<Job | null>;
  /** 原子认领一个 queued 的远端执行器任务，转 dispatched 并返回；无可领则 null。 */
  claimNextJob(targets: string[], executorId: string, leaseMs: number): Promise<Job | null>;
  /** 原子认领一个 queued 的中枢内执行任务，转 running 并返回；无可领则 null。 */
  claimNextInhubJob(targets: string[], workerId: string, leaseMs: number): Promise<Job | null>;
  /** 执行器仍存活时续租它名下的 dispatched 任务。 */
  extendExecutorLeases(executorId: string, leaseMs: number): Promise<number>;
  /** 重排「执行器租约过期或超过硬时限」的 dispatched 任务回 queued。 */
  requeueStaleDispatched(deadAfterMs: number, hardCapMs: number): Promise<number>;
  /** 列出租约过期的任务；缺少 lease_until 时按 updated_at 硬时限判定。 */
  listExpiredLeases(statuses: Array<Job['status']>, fallbackOlderThanMs: number): Promise<Job[]>;
  /** 列出处于指定状态的任务；olderThanMs 给定时仅取 updated_at 早于该时长的任务。 */
  listJobsByStatus(statuses: Array<Job['status']>, olderThanMs?: number): Promise<Job[]>;
  /** queued 超过 ttlMs 仍没被认领时置 error 终态，避免恢复后陈旧任务全量重放。 */
  expireStaleQueued(ttlMs: number): Promise<number>;
  /** 某会话当前在途任务数（queued+running+dispatched）：会话级背压配额用。 */
  countInflightByThread(threadId: number): Promise<number>;
}

export interface AuditLedger {
  appendAudit(entry: AuditEntry): Promise<void>;
  /** 清理早于 cutoffIso 的审计账本；jsonl 本地烟测后端可返回 0。 */
  pruneAuditOlderThan(cutoffIso: string): Promise<number>;
}

export interface RuntimeLockRepository {
  /** 运行期短租约锁：同 owner 可续租；锁不存在或已过期时可抢占。 */
  acquireRuntimeLock(lockKey: string, owner: string, ttlMs: number): Promise<boolean>;
  /** 仅释放自己持有的租约；非持有者释放是 no-op。 */
  releaseRuntimeLock(lockKey: string, owner: string): Promise<void>;
}

export interface RuntimeStateStore extends JobRepository, AuditLedger, RuntimeLockRepository {
  init(): Promise<void>;
}
