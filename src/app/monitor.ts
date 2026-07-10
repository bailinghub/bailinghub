// 中枢自监控：错误率 / 队列积压 / 执行器离线 → 经自家送达插座(sendAlert)告警（吃自己的狗粮）。bootstrap 每 5min 调一次。
import { outboundRuntimeDepsFor, sendAlertWithDeps } from './outbound';
import { displayTzNote, fmtDisplayTime } from '../core/platform/time';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { AppConfig } from '../core/config/config';

// ---- 中枢自监控：错误率/积压/执行器离线 → 经自家送达插座告警（吃自己的狗粮）----
// 运行告警 sendAlert → 见 ./outbound（监控/spec 变更等内部事件出口，含冷却去重）。

export async function runMonitorFor(
  config: ConfigStoreContract | null,
  state: RuntimeStateStore,
  paused: () => boolean,
  appConfig: AppConfig,
  nowFn: () => string,
  sleepFn: (ms: number) => Promise<void>,
): Promise<void> {
  if (!config) return;
  const outboundRuntime = outboundRuntimeDepsFor({ cfg: appConfig, configStore: config, stateStore: state, now: nowFn, sleep: sleepFn });
  try {
    const nowMs = Date.now();
    // 离线判据 = 执行器是否还有「独立心跳」（见 routes/executor.ts /executor/heartbeat：与 claim 解耦，长任务执行期间
    // 仍按 ~30s 上报存活），而非任务时长——长任务是常态，不能因为在跑长活就判执行器掉线。
    // busy 仅作兜底：名下有 dispatched 任务 = 在干活。失联执行器的 dispatched 任务会被 reaper（按 last_seen 僵死，3min）
    // 先重排清掉，故此集合最终只剩真正在干活的执行器，绝不掩盖真离线。
    const busy = new Set(
      (await state.listJobsByStatus(['dispatched'])).map((j) => j.executor_id).filter(Boolean) as string[],
    );
    // 执行器离线：5 分钟没心跳告警；超过 48h 视为已退役不再吵
    for (const e of await config.executors.list()) {
      const ageMs = nowMs - new Date(e.last_seen_at).getTime();
      if (ageMs > 5 * 60_000 && ageMs < 48 * 3600_000 && !busy.has(e.executor_id)) {
        await sendAlertWithDeps(outboundRuntime, `executor_offline_${e.executor_id}`,
          `执行器 ${e.executor_id} 已离线 ${Math.round(ageMs / 60_000)} 分钟（最后心跳 ${fmtDisplayTime(e.last_seen_at)}，${displayTzNote(e.last_seen_at)}），其负责的 target（${e.targets.join('/')}）任务将积压。`);
      }
    }
    const snap = await config.observability.monitorSnapshot();
    if (snap.errors_15m >= 5) {
      await sendAlertWithDeps(outboundRuntime, 'error_burst', `近 15 分钟内任务失败 ${snap.errors_15m} 单，请到控制台「任务」查看失败原因。`);
    }
    if (snap.oldest_queued_min >= 10 && !paused()) {
      await sendAlertWithDeps(outboundRuntime, 'queue_backlog', `有任务排队超过 ${snap.oldest_queued_min} 分钟未被认领，请检查对应执行器是否在线。`);
    }
  } catch { /* 监控自身故障绝不影响主流程，下轮再试 */ }
}
