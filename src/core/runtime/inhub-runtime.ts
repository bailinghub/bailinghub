// inhub 进程内执行运行时：负责 llm 等本地目标的 DB 认领、重跑、恢复与 retry 计时。
// 不依赖 runtime 单例，也不 import engine；engine 只把 processJob 回调注入进来。
import type { RetryDecision } from './execution-runtime';
import type { AuditEntry, Job, Route, SessionTarget } from '../contracts/types';

export type InhubProcessJob = (
  job: Job,
  route: Route | null,
  projectPath: string | null,
  fullInput: string,
  session: SessionTarget,
) => Promise<void>;

export interface InhubStoreLike {
  updateJob(jobId: string, patch: Partial<Job>): Promise<Job | null>;
  updateJobIfStatus(jobId: string, expectedStatuses: Array<Job['status']>, patch: Partial<Job>): Promise<Job | null>;
  claimNextInhubJob(targets: string[], workerId: string, leaseMs: number): Promise<Job | null>;
  listJobsByStatus(statuses: Array<Job['status']>, olderThanMs?: number): Promise<Job[]>;
  listExpiredLeases(statuses: Array<Job['status']>, fallbackOlderThanMs: number): Promise<Job[]>;
  appendAudit(entry: AuditEntry): Promise<void>;
}

export interface PreparedInhubJob {
  job: Job;
  route: Route | null;
  projectPath: string | null;
  fullInput: string;
  session: SessionTarget;
}

export interface InhubTimeoutHandle {
  unref?: () => void;
}

export interface InhubRuntimeDeps {
  store: InhubStoreLike;
  now: () => string;
  isRemoteExecutorTarget: (target: string) => boolean;
  resolveProjectPath: (project: string) => Promise<string | null>;
  runSerial: <T>(key: string | number | undefined, task: () => Promise<T>) => Promise<T>;
  processJob: InhubProcessJob;
  workerId: string;
  leaseMs: number;
  inhubTargets: () => string[];
  prepareClaimedJob: (job: Job) => Promise<PreparedInhubJob>;
  setTimeoutFn?: (fn: () => void, ms: number) => InhubTimeoutHandle | void;
  clearTimeoutFn?: (timer: InhubTimeoutHandle) => void;
}

export interface InhubRuntime {
  refireJob(job: Job): Promise<Job | null>;
  recoverJobs(scope: 'boot' | 'stale', staleMs: number): Promise<number>;
  scheduleRetry(job: Job, route: Route | null, projectPath: string | null, fullInput: string, session: SessionTarget, retry: RetryDecision): Promise<void>;
  kick(): void;
  drain(maxClaims?: number): Promise<number>;
  /** 拒绝新的认领并取消所有进程内 retry 唤醒；已认领工作仍会完成。 */
  closeAdmission(): void;
  /** 关闭 admission，并等待认领/装配及 runSerial/processJob 全部收尾。 */
  stop(): Promise<void>;
}

export function createInhubRuntime(deps: InhubRuntimeDeps): InhubRuntime {
  let accepting = true;
  const retryTimers = new Set<InhubTimeoutHandle>();
  const activeRuns = new Set<Promise<void>>();
  let drainInFlight: Promise<number> | null = null;

  const cancelTimer = deps.clearTimeoutFn ?? ((timer: InhubTimeoutHandle) => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  });

  const schedule = (fn: () => void, ms: number) => {
    if (!accepting) return;
    let fired = false;
    let timer: InhubTimeoutHandle | void;
    const fire = () => {
      fired = true;
      if (timer) retryTimers.delete(timer);
      if (accepting) fn();
    };
    timer = deps.setTimeoutFn ? deps.setTimeoutFn(fire, ms) : setTimeout(fire, ms);
    if (!timer || fired) return;
    if (!accepting) {
      cancelTimer(timer);
      return;
    }
    retryTimers.add(timer);
    timer?.unref?.();
  };

  const run = (job: Job, route: Route | null, projectPath: string | null, fullInput: string, session: SessionTarget) => {
    const work = deps.runSerial(job.thread_id, () => deps.processJob(job, route, projectPath, fullInput, session)).catch(async (e) => {
      await deps.store.updateJob(job.job_id, { status: 'error', error: `处理异常：${String(e)}`, executor_id: undefined, claimed_at: undefined, lease_until: undefined, claim_token: undefined });
    });
    activeRuns.add(work);
    void work.finally(() => activeRuns.delete(work)).catch(() => undefined);
    // 正常运行时 run 是后台链；错误已尽力落账，避免落账自身失败变成未处理拒绝。
    void work.catch(() => undefined);
  };

  const drain: InhubRuntime['drain'] = async (maxClaims = 1) => {
    if (!accepting || drainInFlight) return 0;
    const work = (async () => {
      let n = 0;
      const targets = deps.inhubTargets();
      if (!targets.length) return 0;
      for (let i = 0; i < Math.max(1, maxClaims); i++) {
        if (!accepting) break;
        const claimed = await deps.store.claimNextInhubJob(targets, deps.workerId, deps.leaseMs);
        if (!claimed) break;
        n++;
        await deps.store.appendAudit({
          ts: deps.now(), job_id: claimed.job_id, request_id: claimed.request_id, event: 'inhub_claimed',
          detail: { worker: deps.workerId, target: claimed.target },
        }).catch(() => undefined);
        try {
          const prepared = await deps.prepareClaimedJob(claimed);
          run(prepared.job, prepared.route, prepared.projectPath, prepared.fullInput, prepared.session);
        } catch (e) {
          await deps.store.updateJob(claimed.job_id, { status: 'error', error: `装配异常：${String(e)}`, executor_id: undefined, claimed_at: undefined, lease_until: undefined, claim_token: undefined });
        }
      }
      return n;
    })();
    drainInFlight = work;
    try {
      return await work;
    } finally {
      if (drainInFlight === work) drainInFlight = null;
    }
  };

  const kick: InhubRuntime['kick'] = () => {
    void drain(1).catch(() => undefined);
  };

  const refireJob: InhubRuntime['refireJob'] = async (job) => {
    const patch: Partial<Job> = { status: 'queued', attempts: 0, run_after: undefined, error: undefined, executor_id: undefined, claimed_at: undefined, lease_until: undefined, dispatched_at: undefined, claim_token: undefined };
    if (job.metadata?.['no_delivery']) {
      const meta = { ...job.metadata };
      delete meta['no_delivery'];
      patch.metadata = meta;
    }
    const updated = await deps.store.updateJobIfStatus(job.job_id, [job.status], patch);
    if (updated && !deps.isRemoteExecutorTarget(updated.target ?? '')) {
      kick();
    }
    return updated;
  };

  const recoverJobs: InhubRuntime['recoverJobs'] = async (scope, staleMs) => {
    const jobs = scope === 'boot'
      ? await deps.store.listJobsByStatus(['queued', 'running'])
      : await deps.store.listExpiredLeases(['running'], staleMs);
    let n = 0;
    for (const job of jobs) {
      if (deps.isRemoteExecutorTarget(job.target ?? '')) continue;
      await deps.store.appendAudit({ ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event: 'recovered', detail: { scope, prev_status: job.status } });
      if (job.status === 'running') await refireJob(job);
      n++;
    }
    if (n) kick();
    return n;
  };

  const scheduleRetry: InhubRuntime['scheduleRetry'] = async (job, route, projectPath, fullInput, session, retry) => {
    const due = new Date(Date.now() + Math.max(0, retry.backoffMs)).toISOString();
    const queued = await deps.store.updateJobIfStatus(job.job_id, [job.status], { status: 'queued', attempts: retry.attempt, run_after: due, input: fullInput, executor_id: undefined, claimed_at: undefined, lease_until: undefined, dispatched_at: undefined, claim_token: undefined });
    if (!queued) return;
    await deps.store.appendAudit({
      ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event: 'retry_scheduled',
      detail: { attempt: retry.attempt, max: retry.max, backoff_ms: retry.backoffMs, run_after: due, error: retry.error },
    });
    schedule(() => kick(), retry.backoffMs);
  };

  const closeAdmission: InhubRuntime['closeAdmission'] = () => {
    if (!accepting) return;
    accepting = false;
    for (const timer of retryTimers) {
      try { cancelTimer(timer); } catch { /* admission 已关闭；timer 回调本身也会二次检查 accepting */ }
    }
    retryTimers.clear();
  };

  const stop: InhubRuntime['stop'] = async () => {
    closeAdmission();
    // drain 可能在 await claim/prepare 时新增 run；循环到稳定空集，不能只拍一次快照。
    for (;;) {
      const pending: Promise<unknown>[] = [...activeRuns];
      if (drainInFlight) pending.unshift(drainInFlight);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  };

  return { refireJob, recoverJobs, scheduleRetry, kick, drain, closeAdmission, stop };
}
