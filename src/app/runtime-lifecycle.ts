// 运行期生命周期：启动初始化、配置巡检、目标注册表刷新、后台定时器与崩溃恢复。
// server.ts 只负责 HTTP 分发和 listen，本文件负责“进程起来以后要持续做什么”。
import { setDisplayTimezone } from '../core/platform/time';
import { runMonitorFor } from './monitor';
import { runSpecAutoRefreshFor } from './tools-runtime';
import { defaultTargetRegistry, type TargetRegistry } from '../core/targets/registry';
import { formatConfigDiagnostics, inspectConfig } from '../core/config/config-diagnostics';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { KbService } from '../services/kb';
import type { KbSyncService } from '../services/kbsync';
import type { ToolIndexService } from '../services/tools-index';
import { embedConfigOf } from './tool-context';

const TARGET_REFRESH_MS = 60_000;
const INHUB_DRAIN_MS = 500;
const MONITOR_DELAY_MS = 60_000;
const MONITOR_INTERVAL_MS = 5 * 60_000;
const SPEC_REFRESH_MS = 60_000;
const KB_SYNC_MS = 60_000;
const REAPER_INTERVAL_MS = 60_000;
const TOOL_CALL_CLEANUP_MS = 60 * 60 * 1000;
const AUDIT_RETENTION_CLEANUP_MS = 6 * 60 * 60 * 1000;
const TOOL_INDEX_PREWARM_DELAY_MS = 0;

// 兜底：定期把派发后长时间未回报的 dispatched 任务重排回队列（执行器/网络异常时不至于卡死）。
// 阈值需大于最长任务耗时（出厂能力档上限 6min），这里取 20min。
const REAP_MS = 20 * 60 * 1000;
// 执行器派发件的重排判据：按「执行器是否还活着」，不按任务时长（长任务是常态）。
const EXECUTOR_DEAD_MS = 3 * 60 * 1000;
const EXECUTOR_REAP_HARD_CAP_MS = 2 * 60 * 60 * 1000;
// 排队超时：queued 超此仍没被认领（执行器长时间离线）→ 终态化，避免执行器恢复后陈旧任务全量重放。
const QUEUED_TTL_MS = 30 * 60 * 1000;
const TOOL_CALL_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export interface RuntimeSchedulers {
  stop(): void;
}

export interface RuntimeLifecycleDeps {
  cfg: AppConfig;
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  kbService: KbService | null;
  kbSync: KbSyncService | null;
  toolIndex: ToolIndexService | null;
  isPaused: () => boolean;
  refreshTargets: () => Promise<void>;
  kickInhubScheduler: () => void;
  drainInhubScheduler: (maxClaims?: number) => Promise<number>;
  recoverInhubJobs: (scope: 'boot' | 'stale', staleMs: number) => Promise<number>;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  afterStoresInitialized?: () => Promise<void>;
  /** 可嵌入宿主必须注入 Kernel 自己的 registry；默认实例仅服务旧 OSS 包装。 */
  targetRegistry?: TargetRegistry;
}

export interface ToolIndexPrewarmSummary {
  eligible: number;
  warmed: number;
  failed: number;
  rows: number;
}

/**
 * 冷启动索引预热：只读已持久化向量，不查凭证、不请求 embedding。
 * 按源顺序 best-effort，避免实例重启时瞬间打满数据库连接池；单源失败不影响后续源。
 */
export async function prewarmToolIndexesFor(configStore: ConfigStoreContract, toolIndex: ToolIndexService): Promise<ToolIndexPrewarmSummary> {
  const providers = await configStore.toolProviders.list();
  const eligible = providers.flatMap((provider) => {
    const embedConfig = provider.enabled ? embedConfigOf(provider) : null;
    return embedConfig ? [{ provider, embedConfig }] : [];
  });
  const summary: ToolIndexPrewarmSummary = { eligible: eligible.length, warmed: 0, failed: 0, rows: 0 };
  for (const item of eligible) {
    try {
      summary.rows += await toolIndex.prewarmProvider(item.provider.name, item.embedConfig);
      summary.warmed++;
    } catch {
      summary.failed++;
    }
  }
  return summary;
}

async function appendToolIndexPrewarmAudit(
  deps: RuntimeLifecycleDeps,
  event: 'tool_index_prewarmed' | 'tool_index_prewarm_degraded',
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.stateStore.appendAudit({
      ts: deps.now(), job_id: '-', request_id: 'tools', event, detail,
    }).catch(() => undefined);
  } catch { /* 预热观测不得影响运行时 */ }
}

async function runToolIndexPrewarmFor(deps: RuntimeLifecycleDeps): Promise<void> {
  if (!deps.configStore || !deps.toolIndex) return;
  const startedAt = Date.now();
  await prewarmToolIndexesFor(deps.configStore, deps.toolIndex).then((summary) => {
    return appendToolIndexPrewarmAudit(
      deps,
      summary.failed ? 'tool_index_prewarm_degraded' : 'tool_index_prewarmed',
      { ...summary, duration_ms: Math.max(0, Date.now() - startedAt) },
    );
  }).catch(() => {
    return appendToolIndexPrewarmAudit(deps, 'tool_index_prewarm_degraded', {
      eligible: 0, warmed: 0, failed: 0, rows: 0,
      duration_ms: Math.max(0, Date.now() - startedAt),
      reason: 'provider_list_failed',
    });
  });
}

interface RuntimeMaintenanceActions {
  prewarmToolIndexes(): Promise<void>;
  refreshTargets(): Promise<void>;
  drainInhub(maxClaims?: number): Promise<number>;
  monitor(): Promise<void>;
  refreshSpecs(): Promise<void>;
  syncKnowledgeBases(): Promise<void>;
  reapStaleWork(): Promise<void>;
  cleanupToolCalls(): Promise<void>;
  cleanupAudit(): Promise<void>;
  recoverBoot(): Promise<void>;
}

/**
 * standalone 定时器与 managed Kernel tick 共用同一份维护动作。
 * 这里只定义“做什么”，调度频率与是否使用进程定时器由上层决定。
 */
function runtimeMaintenanceActionsFor(deps: RuntimeLifecycleDeps): RuntimeMaintenanceActions {
  return {
    prewarmToolIndexes: () => runToolIndexPrewarmFor(deps),
    async refreshTargets() {
      await deps.refreshTargets();
      deps.kickInhubScheduler();
    },
    drainInhub: (maxClaims) => deps.drainInhubScheduler(maxClaims),
    monitor: () => runMonitorFor(deps.configStore, deps.stateStore, deps.isPaused, deps.cfg, deps.now, deps.sleep),
    refreshSpecs: () => runSpecAutoRefreshFor(deps.configStore, deps.stateStore, deps.toolIndex, deps.cfg, deps.now, deps.sleep),
    async syncKnowledgeBases() {
      if (!deps.kbSync) return;
      const audits: Array<Promise<unknown>> = [];
      await deps.kbSync.tick((ds, stats, err) => {
        if (err) {
          audits.push(deps.stateStore.appendAudit({ ts: deps.now(), job_id: '-', request_id: 'kb-ds', event: 'kb_ds_sync_error', detail: { ds_id: ds.ds_id, kb_id: ds.kb_id, trigger: 'schedule', error: err } }).catch(() => undefined));
        } else if (stats && (stats.upserted || stats.deleted || stats.errors)) {
          audits.push(deps.stateStore.appendAudit({ ts: deps.now(), job_id: '-', request_id: 'kb-ds', event: 'kb_ds_sync', detail: { ds_id: ds.ds_id, kb_id: ds.kb_id, trigger: 'schedule', ...stats } }).catch(() => undefined));
        }
      });
      await Promise.allSettled(audits);
    },
    async reapStaleWork() {
      await Promise.all([
        deps.stateStore.requeueStaleDispatched(EXECUTOR_DEAD_MS, EXECUTOR_REAP_HARD_CAP_MS)
          .then((n) => { if (n) console.log(`[百灵中枢] reaper 重排 ${n} 个滞留 dispatched 任务回队列（执行器失联/超硬兜底）`); })
          .catch(() => undefined),
        // inhub 僵死兜底：运行中 > REAP_MS 必已死（适配器超时远小于 20min），重新点火。
        deps.recoverInhubJobs('stale', REAP_MS)
          .then((n) => { if (n) console.log(`[百灵中枢] reaper 重新点火 ${n} 个僵死 inhub 任务`); })
          .catch(() => undefined),
        // 排队超时清理：执行器长时间离线时，防止恢复后陈旧任务全量重放。
        deps.stateStore.expireStaleQueued(QUEUED_TTL_MS)
          .then((n) => { if (n) console.log(`[百灵中枢] reaper 过期 ${n} 个排队超时任务（执行器长时间不可用）`); })
          .catch(() => undefined),
      ]);
    },
    async cleanupToolCalls() {
      if (!deps.configStore) return;
      await deps.configStore.toolCalls.cleanup(TOOL_CALL_RETENTION_MS)
        .then((n) => { if (n) console.log(`[百灵中枢] 清理 ${n} 条超龄工具幂等账本`); })
        .catch(() => undefined);
    },
    async cleanupAudit() {
      if (deps.cfg.auditRetentionDays <= 0) return;
      const cutoff = new Date(Date.now() - deps.cfg.auditRetentionDays * 24 * 60 * 60 * 1000).toISOString();
      const deleted = await deps.stateStore.pruneAuditOlderThan(cutoff).catch(() => 0);
      if (!deleted) return;
      console.log(`[百灵中枢] 清理 ${deleted} 条超龄审计账本（保留 ${deps.cfg.auditRetentionDays} 天）`);
      await deps.stateStore.appendAudit({
        ts: deps.now(),
        job_id: '-',
        request_id: 'audit-retention',
        event: 'audit_retention_pruned',
        detail: { retention_days: deps.cfg.auditRetentionDays, cutoff, deleted },
      }).catch(() => undefined);
    },
    async recoverBoot() {
      await deps.recoverInhubJobs('boot', REAP_MS)
        .then((n) => { if (n) console.log(`[百灵中枢] 崩溃恢复：重新点火 ${n} 个孤儿 inhub 任务`); })
        .catch((e) => console.error('[百灵中枢] inhub boot 恢复失败', e));
    },
  };
}

export async function initializeRuntimeLifecycleFor(deps: RuntimeLifecycleDeps): Promise<void> {
  await deps.stateStore.init();
  if (deps.configStore) await deps.configStore.init();
  if (deps.afterStoresInitialized) await deps.afterStoresInitialized();
  (deps.targetRegistry ?? defaultTargetRegistry).bindStore(deps.configStore);

  // 插座板：启动加载 DB 目标注册表（失败用内置兜底），之后由后台定时器刷新 + 后台改动即时刷新。
  await deps.refreshTargets();

  if (deps.configStore) {
    const report = await inspectConfig(deps.configStore, { cfg: deps.cfg, kbService: deps.kbService }).catch((e) => ({
      ok: false,
      errors: 1,
      warnings: 0,
      diagnostics: [{ severity: 'error' as const, area: 'system', id: 'config-diagnostics', message: `配置巡检异常：${String(e)}` }],
    }));
    const text = formatConfigDiagnostics(report);
    if (report.errors || report.warnings) console.warn(`[百灵中枢] ${text}`);
    else console.log(`[百灵中枢] ${text}`);
    void deps.stateStore.appendAudit({
      ts: deps.now(), job_id: '-', request_id: 'config', event: 'config_diagnostics',
      detail: { errors: report.errors, warnings: report.warnings, diagnostics: report.diagnostics.slice(0, 50) },
    }).catch(() => undefined);
  }

  // 展示时区注入：把实例配置喂给 time.ts 这个唯一转换点（所有「给大脑/给人看」的时间都经它）。
  setDisplayTimezone(deps.cfg.displayTz, deps.cfg.displayTzLabel);
}

export interface ManagedRuntimeMaintenance {
  /**
   * 由宿主的单一全局心跳驱动。为保持 inhub 队列的低延迟，建议宿主每 500ms 左右调用；
   * 其余维护项在内部按各自周期节流，不会因高频 tick 重复执行。
   */
  tick(maxClaims?: number): Promise<number>;
  /**
   * 停止接受新 tick，并在时限内等待已启动的维护动作收尾。
   * false 表示仍有在途动作；资源不应关闭，宿主可在原实例上重试 stop/close。
   */
  stop(drainMs?: number): Promise<boolean>;
}

interface ManagedMaintenanceTask {
  key: string;
  nextDueAt: number;
  repeatMs: number | null;
  persistDue: boolean;
  running: Promise<void> | null;
  run(): Promise<void>;
}

/**
 * Host-owned schedule state survives an idle Kernel eviction. It intentionally
 * contains no Store or timer reference, so retaining it for many tenants is
 * cheap and cannot keep a tenant database pool alive.
 */
export interface ManagedRuntimeMaintenanceStateV1 {
  nextDueAtByTask: Record<string, number>;
}

export function createManagedRuntimeMaintenanceStateV1(): ManagedRuntimeMaintenanceStateV1 {
  return { nextDueAtByTask: Object.create(null) as Record<string, number> };
}

/**
 * managed Kernel 的无定时器维护驱动器。
 *
 * 宿主只需维护一个全局心跳，逐个调用活跃 Kernel.tick；每个 Kernel 只保留
 * 下次到期时间和 single-flight 状态，不创建 setInterval/setTimeout。耗时维护在各自 Kernel
 * 内后台执行，避免一个租户的知识库同步阻塞全局心跳；stop 会在关库前等它们收尾。
 */
export function createManagedRuntimeMaintenanceFor(
  deps: RuntimeLifecycleDeps,
  options: {
    nowMs?: () => number;
    state?: ManagedRuntimeMaintenanceStateV1;
  } = {},
): ManagedRuntimeMaintenance {
  const actions = runtimeMaintenanceActionsFor(deps);
  // 周期调度用单调时钟，避免系统时间/NTP 回拨让租户维护长时间停摆。
  const nowMs = options.nowMs ?? (() => performance.now());
  const startedAt = nowMs();
  const state = options.state;
  const scheduled = (
    key: string,
    initialDelayMs: number,
    repeatMs: number | null,
    run: () => Promise<void>,
    persistDue = true,
  ): ManagedMaintenanceTask => {
    const remembered = persistDue ? state?.nextDueAtByTask[key] : undefined;
    const nextDueAt = typeof remembered === 'number' && !Number.isNaN(remembered)
      ? remembered
      : startedAt + initialDelayMs;
    if (persistDue && state) state.nextDueAtByTask[key] = nextDueAt;
    return { key, nextDueAt, repeatMs, persistDue, running: null, run };
  };
  const tasks: ManagedMaintenanceTask[] = [
    // Prewarm is per Kernel cache, so it must run again after an eviction.
    scheduled('tool-index-prewarm', 0, null, actions.prewarmToolIndexes, false),
    scheduled('boot-recovery', 2_000, null, actions.recoverBoot),
    scheduled('target-refresh', TARGET_REFRESH_MS, TARGET_REFRESH_MS, actions.refreshTargets),
    scheduled('monitor', MONITOR_DELAY_MS, MONITOR_INTERVAL_MS, actions.monitor),
    scheduled('spec-refresh', SPEC_REFRESH_MS, SPEC_REFRESH_MS, actions.refreshSpecs),
    ...(deps.kbSync
      ? [scheduled('kb-sync', KB_SYNC_MS, KB_SYNC_MS, actions.syncKnowledgeBases)]
      : []),
    scheduled('reaper', REAPER_INTERVAL_MS, REAPER_INTERVAL_MS, actions.reapStaleWork),
    ...(deps.configStore
      ? [scheduled('tool-call-cleanup', TOOL_CALL_CLEANUP_MS, TOOL_CALL_CLEANUP_MS, actions.cleanupToolCalls)]
      : []),
    ...(deps.cfg.auditRetentionDays > 0
      ? [
        scheduled('audit-cleanup-initial', 60_000, null, actions.cleanupAudit),
        scheduled('audit-cleanup-recurring', AUDIT_RETENTION_CLEANUP_MS, AUDIT_RETENTION_CLEANUP_MS, actions.cleanupAudit),
      ]
      : []),
  ];
  const inFlight = new Set<Promise<unknown>>();
  let drainInFlight: Promise<number> | null = null;
  let stopped = false;

  function track<T>(promise: Promise<T>): Promise<T> {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
    return promise;
  }

  function launchDue(task: ManagedMaintenanceTask, tickAt: number): void {
    if (task.running || tickAt < task.nextDueAt) return;
    // 先推进到期点：故障或长暂停后只跑一次，不做无意义的“补钟风暴”。
    task.nextDueAt = task.repeatMs === null ? Number.POSITIVE_INFINITY : tickAt + task.repeatMs;
    if (task.persistDue && state) state.nextDueAtByTask[task.key] = task.nextDueAt;
    const work = track(Promise.resolve().then(task.run).catch(() => undefined));
    task.running = work;
    void work.finally(() => {
      if (task.running === work) task.running = null;
    }).catch(() => undefined);
  }

  async function tick(maxClaims = 1): Promise<number> {
    if (stopped) return 0;
    const tickAt = nowMs();
    for (const task of tasks) launchDue(task, tickAt);

    // 并发的宿主心跳共享一次 drain，不在同一租户库上叠加认领查询。
    if (!drainInFlight) {
      const work = track(actions.drainInhub(maxClaims));
      drainInFlight = work;
      void work.finally(() => {
        if (drainInFlight === work) drainInFlight = null;
      }).catch(() => undefined);
    }
    return await drainInFlight;
  }

  async function stop(drainMs = 30_000): Promise<boolean> {
    stopped = true;
    if (inFlight.size === 0) return true;
    const pending = Promise.allSettled([...inFlight]).then(() => true);
    const boundedDrainMs = Number.isFinite(drainMs) ? Math.max(0, Math.floor(drainMs)) : 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        pending,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(1, boundedDrainMs));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { tick, stop };
}

export function startRuntimeSchedulersFor(deps: RuntimeLifecycleDeps): RuntimeSchedulers {
  const actions = runtimeMaintenanceActionsFor(deps);
  const timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];
  const every = (fn: () => void, ms: number): void => {
    const timer = setInterval(fn, ms);
    timer.unref();
    timers.push(timer);
  };
  const later = (fn: () => void, ms: number): void => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    timers.push(timer);
  };

  // 服务先启动，索引随后在后台预热；任何数据库/索引异常都不阻塞 HTTP 就绪。
  later(() => void actions.prewarmToolIndexes(), TOOL_INDEX_PREWARM_DELAY_MS);

  every(() => void actions.refreshTargets().catch(() => undefined), TARGET_REFRESH_MS);

  // inhub DB 调度器：llm 等中枢内目标也从 bz_jobs 队列认领，避免依赖建单进程的内存 promise。
  // kick 提供低延迟，tick 提供兜底与多实例拾取；认领本身在 DB 里原子化。
  every(() => void actions.drainInhub(1).catch(() => undefined), INHUB_DRAIN_MS);

  // 自监控：启动 1 分钟后首跑，避开冷启动误报。
  later(() => {
    void actions.monitor();
    every(() => void actions.monitor(), MONITOR_INTERVAL_MS);
  }, MONITOR_DELAY_MS);

  // 工具源 spec 自动刷新：每分钟扫一遍，按各源 auto_refresh_min 节流。
  every(() => void actions.refreshSpecs().catch(() => undefined), SPEC_REFRESH_MS);

  // 知识库数据源连接器：每分钟扫一遍到点的（变更/出错记审计，平稳无事不刷流水）。
  if (deps.kbSync) {
    every(() => void actions.syncKnowledgeBases().catch(() => undefined), KB_SYNC_MS);
  }

  every(() => void actions.reapStaleWork(), REAPER_INTERVAL_MS);

  // 执行日志清理：只删除超龄且已确认 completed 的行；未决状态必须保留给人工对账。
  every(() => void actions.cleanupToolCalls(), TOOL_CALL_CLEANUP_MS);

  if (deps.cfg.auditRetentionDays > 0) {
    later(() => void actions.cleanupAudit(), 60_000);
    every(() => void actions.cleanupAudit(), AUDIT_RETENTION_CLEANUP_MS);
  }

  return {
    stop() {
      for (const timer of timers.splice(0)) clearTimeout(timer);
    },
  };
}

export function scheduleBootRecoveryFor(deps: RuntimeLifecycleDeps): ReturnType<typeof setTimeout> {
  const actions = runtimeMaintenanceActionsFor(deps);
  // 崩溃恢复：boot 时把上一进程遗留的 inhub running 任务放回 DB 队列；queued 任务由 inhub 调度器继续认领。
  // 延后到 listen 之后再跑（不阻塞开始收流量，也避开冷启动抢资源）。
  const timer = setTimeout(() => {
    void actions.recoverBoot();
  }, 2000).unref();
  return timer;
}
