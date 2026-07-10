// 调度引擎：中枢核心编排——入口落单(launch-runtime) / inhub 点火与恢复(inhub-runtime) /
// 执行上下文(execution-runtime) / 收尾送达(finish-runtime) / 滚动摘要(summary-runtime)。
//
// 本文件只暴露 createEngineRuntime(deps) 作为可装配运行时；OSS 默认包装函数在 engine-default.ts。
// 自定义运行时应创建自己的 EngineRuntime，并按组织/资源 scope 注入 store、config、queue 与服务实例。
import { randomUUID } from 'node:crypto';
import { fireCallbackWithDeps, outboundRuntimeDepsFor, sendAlertWithDeps } from './outbound';
import { runSerial } from '../core/platform/serial';
import { resolveSendChannelsFor, runSendMessageFor, sendToolDef } from './builtin-tools';
import { assembleToolRuntimeFor } from './tool-assembly';
import { callLlmText } from '../core/runtime/memory';
import { getAdapter, getTargetDef, listTargetDefs } from '../core/targets/registry';
import type { Job, Route, SessionTarget, TargetDef } from '../core/contracts/types';
import { spawnDeliveryJobFor } from './delivery';
import { resolveSummaryCredential } from '../core/runtime/credential-resolver';
import { prepareAdapterContext, retryDecision } from '../core/runtime/execution-runtime';
import { finishJob } from '../core/runtime/finish-runtime';
import { createSummaryRuntime } from '../core/runtime/summary-runtime';
import { launchJobRecord, rejectLaunchJob, type LaunchSpec } from '../core/runtime/launch-runtime';
import { createInhubRuntime, type PreparedInhubJob } from '../core/runtime/inhub-runtime';
import { checkLaunchBudget } from '../core/runtime/budget-runtime';
import { assembleDispatchContext } from '../core/runtime/context-runtime';
import { resolveMemoryConfig } from '../core/runtime/memory';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { Queue } from '../core/platform/queue';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { KbService } from '../services/kb';
import type { ToolIndexService } from '../services/tools-index';

const INHUB_SERIAL_LOCK_TTL_MS = 120_000;
const INHUB_SERIAL_LOCK_MAX_WAIT_MS = 25 * 60 * 1000;
const INHUB_JOB_LEASE_MS = 20 * 60 * 1000;

export interface EngineRuntimeDeps {
  cfg: AppConfig;
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  kbService: KbService | null;
  toolIndex: ToolIndexService | null;
  queue: Pick<Queue, 'run'>;
  isPaused: () => boolean;
  resolveProjectPath: (name: string) => Promise<string | null>;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  launchGuard?: (spec: LaunchSpec) => Promise<LaunchGuardDecision> | LaunchGuardDecision;
}

export interface LaunchGuardDecision {
  ok: boolean;
  reason?: string;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface EngineRuntime {
  refreshTargets(): Promise<void>;
  waitForJob(jobId: string, waitMs: number): Promise<Job | null>;
  launchJob(spec: LaunchSpec): Promise<Job>;
  requeueForRerun(job: Job, by: string, via: string): Promise<void>;
  recoverInhubJobs(scope: 'boot' | 'stale', staleMs: number): Promise<number>;
  kickInhubScheduler(): void;
  drainInhubScheduler(maxClaims?: number): Promise<number>;
  finish(job: Job, patch: Partial<Job>): Promise<void>;
}

export function createEngineRuntime(deps: EngineRuntimeDeps): EngineRuntime {
  let targetDefs = new Map<string, TargetDef>(listTargetDefs().map((target) => [target.name, target]));

  async function refreshEngineTargets(): Promise<void> {
    const next = new Map<string, TargetDef>(listTargetDefs().map((target) => [target.name, target]));
    if (deps.configStore) {
      try {
        for (const target of await deps.configStore.targets.list()) next.set(target.name, target);
      } catch {
        // 配置仓储短暂不可用时保留内置目标，避免调度器被 DB 抖动放倒。
      }
    }
    targetDefs = next;
  }

  function targetDef(name: string): TargetDef | null {
    return targetDefs.get(name) ?? getTargetDef(name);
  }

  function isRemoteExecutorTargetForEngine(target: string): boolean {
    return targetDef(target)?.kind === 'executor';
  }

  function targetIsStatelessForEngine(target: string): boolean {
    return targetDef(target)?.stateless === true;
  }

  function targetTimeoutMsForEngine(target: string, targetConfig: Record<string, unknown>): number {
    const fromRoute = Number(targetConfig['timeout_ms']);
    if (fromRoute > 0) return fromRoute;
    const fromDef = targetDef(target)?.timeout_ms ?? 0;
    return fromDef > 0 ? fromDef : 120000;
  }

  const summaryRuntime = createSummaryRuntime({
    cfg: deps.cfg,
    summaryStore: deps.configStore?.conversations,
    credentialStore: deps.configStore?.credentials,
    auditStore: deps.stateStore,
    lockStore: deps.stateStore,
    now: deps.now,
    resolveSummaryCredential,
    callLlmText,
  });

  const inhubSerialOwner = `inhub:${process.pid}:${randomUUID()}`;
  const runInhubSerial = <T>(key: string | number | undefined, task: () => Promise<T>) => runSerial(key, task, {
    lease: deps.stateStore,
    owner: inhubSerialOwner,
    ttlMs: INHUB_SERIAL_LOCK_TTL_MS,
    maxWaitMs: INHUB_SERIAL_LOCK_MAX_WAIT_MS,
  });

  const inhubRuntime = createInhubRuntime({
    store: deps.stateStore,
    now: deps.now,
    isRemoteExecutorTarget: isRemoteExecutorTargetForEngine,
    resolveProjectPath: deps.resolveProjectPath,
    runSerial: runInhubSerial,
    processJob,
    workerId: inhubSerialOwner,
    leaseMs: INHUB_JOB_LEASE_MS,
    inhubTargets: () => [...targetDefs.values()].filter((t) => t.enabled !== false && t.kind === 'inhub' && !!getAdapter(t.name)).map((t) => t.name),
    prepareClaimedJob,
  });

  /** 限内等待任务到终态：用于企微等存在平台被动回复窗口的渠道；网页聊天结果统一走 SSE。 */
  async function waitForJob(jobId: string, waitMs: number): Promise<Job | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const j = await deps.stateStore.getJob(jobId);
      if (j && j.status !== 'queued' && j.status !== 'running' && j.status !== 'dispatched') return j;
      if (Date.now() >= deadline) return j;
      await deps.sleep(400);
    }
  }

  /**
   * 任务落地共用件（/run 与 /chat 共用）：总账装配 → 知识注入 → 建单审计 → 派发
   * （inhub/executor 都进 DB 队列，由各自 worker 认领）。
   * 调用方负责自己的鉴权/限速/幂等/路由校验；本函数只做"从合法请求到在跑任务"。
   */
  async function launchJob(s: LaunchSpec): Promise<Job> {
    await refreshEngineTargets();
    const guard = deps.launchGuard ? await deps.launchGuard(s) : { ok: true };
    if (!guard.ok) {
      return await rejectLaunchJob(s, { store: deps.stateStore, now: deps.now }, {
        reason: guard.reason ?? 'launch_guard_rejected',
        error: guard.error ?? '请求未通过运行时入口限制',
        detail: guard.detail,
      });
    }

    const client = s.clientAppId && deps.configStore ? await deps.configStore.clients.get(s.clientAppId).catch(() => null) : null;
    const budget = await checkLaunchBudget({ route: s.route, client, store: deps.configStore?.observability });
    if (!budget.ok) {
      return await rejectLaunchJob(s, { store: deps.stateStore, now: deps.now }, {
        reason: `budget_${budget.scope ?? 'unknown'}_${budget.reason ?? 'exceeded'}`,
        error: '预算闸拒绝：该场景或接入方在当前窗口内已达到成本/Token 硬限',
        detail: {
          scope: budget.scope,
          reason: budget.reason,
          usage: budget.usage,
          policy: budget.policy,
        },
      });
    }

    const launched = await launchJobRecord(s, {
      store: deps.stateStore,
      ledger: deps.configStore?.conversations,
      knowledgeService: deps.kbService,
      now: deps.now,
      isRemoteExecutorTarget: isRemoteExecutorTargetForEngine,
      targetIsStateless: targetIsStatelessForEngine,
    });
    const { job } = launched;
    if (job.status === 'rejected') return job;

    if (!launched.isRemoteExecutor) {
      inhubRuntime.kick();
    }
    return job;
  }

  /** 重跑共用：回 queued + 记 rerun 审计；inhub 目标由 DB 调度器重新认领。控制台重跑与审批批准共用。 */
  async function requeueForRerun(job: Job, by: string, via: string): Promise<void> {
    await inhubRuntime.refireJob(job);
    await deps.stateStore.appendAudit({
      ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event: 'rerun',
      detail: { by, via, prev_status: job.status },
    });
  }

  /** inhub 崩溃/僵死恢复：inhub(llm)任务也在 DB 队列里，恢复只负责把僵死 running 放回 queued 并唤醒调度器。
   * 与 requeueStaleDispatched（管执行器"派出去没回报"）对称，这条管中枢自己崩在 LLM 中途：
   *  - boot：queued 直接可认领，running 属于上一进程遗留，回 queued；
   *  - stale：只捞 running 且 updated_at 僵死 > staleMs 的，回 queued；
   *    绝不周期性改 queued；queued 的 run_after 由 claim 层判断。
   * 远端执行器目标有自己的原子认领 + requeueStaleDispatched，跳过不管。 */
  async function recoverInhubJobs(scope: 'boot' | 'stale', staleMs: number): Promise<number> {
    await refreshEngineTargets();
    return inhubRuntime.recoverJobs(scope, staleMs);
  }

  function kickInhubScheduler(): void {
    inhubRuntime.kick();
  }

  async function drainInhubScheduler(maxClaims = 1): Promise<number> {
    await refreshEngineTargets();
    return await inhubRuntime.drain(maxClaims);
  }

  async function prepareClaimedJob(job: Job): Promise<PreparedInhubJob> {
    const routeKey = typeof job.dispatch?.route_key === 'string' ? job.dispatch.route_key : '';
    const route = routeKey && deps.configStore ? await deps.configStore.routes.get(routeKey).catch(() => null) : null;
    const projectPath = job.project ? await deps.resolveProjectPath(job.project) : null;
    const session: SessionTarget = { sessionId: job.session_id ?? randomUUID(), isContinue: !!job.dispatch?.is_continue };
    const fullInput = job.input ?? job.input_preview ?? '';
    const memCfg = resolveMemoryConfig((route?.memory ?? job.dispatch?.memory) as Record<string, unknown> | undefined);
    const a = await assembleDispatchContext({
      route,
      metadata: job.metadata ?? {},
      fullInput,
      requestId: job.request_id,
      permission: route?.permission,
      safeInput: fullInput,
      threadId: job.thread_id,
      memory: memCfg,
      memoryEnabled: !!(job.thread_id && (targetIsStatelessForEngine(job.target ?? '') || !session.isContinue)),
      memoryStore: deps.configStore?.conversations,
      knowledgeService: deps.kbService,
      audit: (event, detail) => deps.stateStore.appendAudit({ ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event, detail }),
    });
    const dispatch = {
      ...job.dispatch,
      ...(a.kbRefs ? { kb_refs: a.kbRefs } : {}),
      ...(a.userImages.length ? { user_images: a.userImages } : {}),
      ...(a.userAudio.length ? { user_audio: a.userAudio } : {}),
      ...(a.userFiles.length ? { user_files: a.userFiles } : {}),
    } as Job['dispatch'];
    const updated = await deps.stateStore.updateJob(job.job_id, { input: a.dispatchInput, dispatch });
    return { job: updated ?? job, route, projectPath, fullInput: a.dispatchInput, session };
  }

  async function processJob(job: Job, route: Route | null, projectPath: string | null, fullInput: string, session: SessionTarget): Promise<void> {
    await deps.queue.run(async () => {
      if (deps.isPaused()) {
        await deps.stateStore.updateJob(job.job_id, { status: 'rejected', error: 'kill switch 暂停', executor_id: undefined, claimed_at: undefined, lease_until: undefined, dispatched_at: undefined, claim_token: undefined });
        return;
      }
      const claimed = job.status === 'running'
        ? job
        : await deps.stateStore.updateJobIfStatus(job.job_id, ['queued'], {
          status: 'running',
          run_after: undefined,
          claimed_at: deps.now(),
          lease_until: new Date(Date.now() + INHUB_JOB_LEASE_MS).toISOString(),
        });
      if (!claimed) return;
      job = claimed;
      await deps.stateStore.appendAudit({ ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event: 'started', detail: { target: job.target } });

      const adapter = job.target ? getAdapter(job.target) : null;
      if (!adapter) { await finish(job, { status: 'error', error: `未实现的 target: ${job.target}` }); return; }

      const ctx = await prepareAdapterContext({
        job,
        route,
        fullInput,
        session,
        projectPath,
        cfg: deps.cfg,
        credentialStore: deps.configStore?.credentials,
        targetTimeoutMs: targetTimeoutMsForEngine,
        assembleToolRuntime: (toolJob, toolRoute) => assembleToolRuntimeFor(deps.configStore, deps.stateStore, deps.toolIndex, toolJob, toolRoute, deps.cfg, deps.now, deps.sleep),
        resolveSendChannels: (toolsConfig) => resolveSendChannelsFor(deps.configStore, toolsConfig),
        makeSendToolDef: sendToolDef,
        runSendMessage: (sendJob, channels, args, audit) => runSendMessageFor(deps.configStore, sendJob, channels, args, audit),
        audit: (event, detail) => deps.stateStore.appendAudit({ ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event, detail }),
      });
      const result = await adapter.run(ctx);

      // 瞬时失败 + 路由配了重试 → 退避后重跑，不进终态（配置类错误 transient=false 不会走到这）
      const retry = retryDecision(job, route, result);
      if (retry) {
        await inhubRuntime.scheduleRetry(job, route, projectPath, fullInput, session, retry);
        return;
      }

      await finish(job, {
        status: result.ok ? 'done' : 'error',
        session_id: result.sessionId ?? job.session_id,
        usage: result.usage,
        result: result.output,
        error: result.error,
      });
    });
  }

  async function finish(job: Job, patch: Partial<Job>): Promise<void> {
    const outboundRuntime = outboundRuntimeDepsFor({
      cfg: deps.cfg,
      configStore: deps.configStore,
      stateStore: deps.stateStore,
      now: deps.now,
      sleep: deps.sleep,
    });
    await finishJob(job, patch, {
      store: deps.stateStore,
      conversationLedger: deps.configStore?.conversations,
      deliveryDlq: deps.configStore?.deliveryDlq,
      now: deps.now,
      fireCallback: (url, callbackJob) => fireCallbackWithDeps(outboundRuntime, url, callbackJob),
      spawnDeliveryJob: (deliveryJob) => spawnDeliveryJobFor({
        cfg: deps.cfg,
        configStore: deps.configStore,
        stateStore: deps.stateStore,
        now: deps.now,
        sleep: deps.sleep,
      }, deliveryJob),
      sendAlert: (key, text) => sendAlertWithDeps(outboundRuntime, key, text),
      summarizeThread: summaryRuntime.maybeSummarizeThread,
    });
  }

  return {
    refreshTargets: refreshEngineTargets,
    waitForJob,
    launchJob,
    requeueForRerun,
    recoverInhubJobs,
    kickInhubScheduler,
    drainInhubScheduler,
    finish,
  };
}
