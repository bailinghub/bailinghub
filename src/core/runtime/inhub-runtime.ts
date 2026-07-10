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
  setTimeoutFn?: (fn: () => void, ms: number) => { unref?: () => void } | void;
}

export interface InhubRuntime {
  refireJob(job: Job): Promise<Job | null>;
  recoverJobs(scope: 'boot' | 'stale', staleMs: number): Promise<number>;
  scheduleRetry(job: Job, route: Route | null, projectPath: string | null, fullInput: string, session: SessionTarget, retry: RetryDecision): Promise<void>;
  kick(): void;
  drain(maxClaims?: number): Promise<number>;
}

export function createInhubRuntime(deps: InhubRuntimeDeps): InhubRuntime {
  const schedule = (fn: () => void, ms: number) => {
    const timer = deps.setTimeoutFn ? deps.setTimeoutFn(fn, ms) : setTimeout(fn, ms);
    timer?.unref?.();
  };

  const run = (job: Job, route: Route | null, projectPath: string | null, fullInput: string, session: SessionTarget) => {
    void deps.runSerial(job.thread_id, () => deps.processJob(job, route, projectPath, fullInput, session)).catch(async (e) => {
      await deps.store.updateJob(job.job_id, { status: 'error', error: `处理异常：${String(e)}`, executor_id: undefined, claimed_at: undefined, lease_until: undefined, claim_token: undefined });
    });
  };

  let draining = false;

  const drain: InhubRuntime['drain'] = async (maxClaims = 1) => {
    if (draining) return 0;
    draining = true;
    let n = 0;
    try {
      const targets = deps.inhubTargets();
      if (!targets.length) return 0;
      for (let i = 0; i < Math.max(1, maxClaims); i++) {
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
    } finally {
      draining = false;
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

  return { refireJob, recoverJobs, scheduleRetry, kick, drain };
}
