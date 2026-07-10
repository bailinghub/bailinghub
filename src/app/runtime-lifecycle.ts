// 运行期生命周期：启动初始化、配置巡检、目标注册表刷新、后台定时器与崩溃恢复。
// server.ts 只负责 HTTP 分发和 listen，本文件负责“进程起来以后要持续做什么”。
import { setDisplayTimezone } from '../core/platform/time';
import { runMonitorFor } from './monitor';
import { runSpecAutoRefreshFor } from './tools-runtime';
import { bindTargetRegistryStore } from '../core/targets/registry';
import { formatConfigDiagnostics, inspectConfig } from '../core/config/config-diagnostics';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { KbService } from '../services/kb';
import type { KbSyncService } from '../services/kbsync';
import type { ToolIndexService } from '../services/tools-index';

const TARGET_REFRESH_MS = 60_000;
const INHUB_DRAIN_MS = 500;
const MONITOR_DELAY_MS = 60_000;
const MONITOR_INTERVAL_MS = 5 * 60_000;
const SPEC_REFRESH_MS = 60_000;
const KB_SYNC_MS = 60_000;
const REAPER_INTERVAL_MS = 60_000;
const TOOL_CALL_CLEANUP_MS = 60 * 60 * 1000;
const AUDIT_RETENTION_CLEANUP_MS = 6 * 60 * 60 * 1000;

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
}

export async function initializeRuntimeLifecycleFor(deps: RuntimeLifecycleDeps): Promise<void> {
  await deps.stateStore.init();
  if (deps.configStore) await deps.configStore.init();
  bindTargetRegistryStore(deps.configStore);

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

export function startRuntimeSchedulersFor(deps: RuntimeLifecycleDeps): RuntimeSchedulers {
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

  every(() => void deps.refreshTargets().then(() => deps.kickInhubScheduler()).catch(() => undefined), TARGET_REFRESH_MS);

  // inhub DB 调度器：llm 等中枢内目标也从 bz_jobs 队列认领，避免依赖建单进程的内存 promise。
  // kick 提供低延迟，tick 提供兜底与多实例拾取；认领本身在 DB 里原子化。
  every(() => void deps.drainInhubScheduler(1).catch(() => undefined), INHUB_DRAIN_MS);

  // 自监控：启动 1 分钟后首跑，避开冷启动误报。
  later(() => {
    void runMonitorFor(deps.configStore, deps.stateStore, deps.isPaused, deps.cfg, deps.now, deps.sleep);
    every(() => void runMonitorFor(deps.configStore, deps.stateStore, deps.isPaused, deps.cfg, deps.now, deps.sleep), MONITOR_INTERVAL_MS);
  }, MONITOR_DELAY_MS);

  // 工具源 spec 自动刷新：每分钟扫一遍，按各源 auto_refresh_min 节流。
  every(() => void runSpecAutoRefreshFor(deps.configStore, deps.stateStore, deps.toolIndex, deps.cfg, deps.now, deps.sleep).catch(() => undefined), SPEC_REFRESH_MS);

  // 知识库数据源连接器：每分钟扫一遍到点的（变更/出错记审计，平稳无事不刷流水）。
  if (deps.kbSync) {
    const ks = deps.kbSync;
    every(() => void ks.tick((ds, stats, err) => {
      if (err) {
        void deps.stateStore.appendAudit({ ts: deps.now(), job_id: '-', request_id: 'kb-ds', event: 'kb_ds_sync_error', detail: { ds_id: ds.ds_id, kb_id: ds.kb_id, trigger: 'schedule', error: err } }).catch(() => undefined);
      } else if (stats && (stats.upserted || stats.deleted || stats.errors)) {
        void deps.stateStore.appendAudit({ ts: deps.now(), job_id: '-', request_id: 'kb-ds', event: 'kb_ds_sync', detail: { ds_id: ds.ds_id, kb_id: ds.kb_id, trigger: 'schedule', ...stats } }).catch(() => undefined);
      }
    }).catch(() => undefined), KB_SYNC_MS);
  }

  every(() => {
    void deps.stateStore.requeueStaleDispatched(EXECUTOR_DEAD_MS, EXECUTOR_REAP_HARD_CAP_MS)
      .then((n) => { if (n) console.log(`[百灵中枢] reaper 重排 ${n} 个滞留 dispatched 任务回队列（执行器失联/超硬兜底）`); })
      .catch(() => { /* 忽略，下次再扫 */ });
    // inhub 僵死兜底：运行中 > REAP_MS 必已死（适配器超时远小于 20min），重新点火（不碰 queued，可能是活计时器）。
    void deps.recoverInhubJobs('stale', REAP_MS)
      .then((n) => { if (n) console.log(`[百灵中枢] reaper 重新点火 ${n} 个僵死 inhub 任务`); })
      .catch(() => { /* 忽略，下次再扫 */ });
    // 排队超时清理：超 TTL 未被认领的 queued 任务终态化（执行器长时间离线 → 陈旧任务不再恢复后全量重放）。
    void deps.stateStore.expireStaleQueued(QUEUED_TTL_MS)
      .then((n) => { if (n) console.log(`[百灵中枢] reaper 过期 ${n} 个排队超时任务（执行器长时间不可用）`); })
      .catch(() => { /* 忽略，下次再扫 */ });
  }, REAPER_INTERVAL_MS);

  // 幂等账本清理：每小时删超 3 天的 bz_tool_calls 行（只在 job 活跃期有用，终态后即死重量，防无界增长）。
  every(() => {
    if (!deps.configStore) return;
    void deps.configStore.toolCalls.cleanup(TOOL_CALL_RETENTION_MS)
      .then((n) => { if (n) console.log(`[百灵中枢] 清理 ${n} 条超龄工具幂等账本`); })
      .catch(() => { /* 忽略，下次再扫 */ });
  }, TOOL_CALL_CLEANUP_MS);

  if (deps.cfg.auditRetentionDays > 0) {
    const cleanupAudit = (): void => {
      const cutoff = new Date(Date.now() - deps.cfg.auditRetentionDays * 24 * 60 * 60 * 1000).toISOString();
      void deps.stateStore.pruneAuditOlderThan(cutoff)
        .then((n) => {
          if (!n) return;
          console.log(`[百灵中枢] 清理 ${n} 条超龄审计账本（保留 ${deps.cfg.auditRetentionDays} 天）`);
          void deps.stateStore.appendAudit({
            ts: deps.now(),
            job_id: '-',
            request_id: 'audit-retention',
            event: 'audit_retention_pruned',
            detail: { retention_days: deps.cfg.auditRetentionDays, cutoff, deleted: n },
          }).catch(() => undefined);
        })
        .catch(() => { /* 忽略，下次再扫 */ });
    };
    later(cleanupAudit, 60_000);
    every(cleanupAudit, AUDIT_RETENTION_CLEANUP_MS);
  }

  return {
    stop() {
      for (const timer of timers.splice(0)) clearTimeout(timer);
    },
  };
}

export function scheduleBootRecoveryFor(deps: RuntimeLifecycleDeps): ReturnType<typeof setTimeout> {
  // 崩溃恢复：boot 时把上一进程遗留的 inhub running 任务放回 DB 队列；queued 任务由 inhub 调度器继续认领。
  // 延后到 listen 之后再跑（不阻塞开始收流量，也避开冷启动抢资源）。
  const timer = setTimeout(() => {
    void deps.recoverInhubJobs('boot', REAP_MS)
      .then((n) => { if (n) console.log(`[百灵中枢] 崩溃恢复：重新点火 ${n} 个孤儿 inhub 任务`); })
      .catch((e) => console.error('[百灵中枢] inhub boot 恢复失败', e));
  }, 2000).unref();
  return timer;
}
