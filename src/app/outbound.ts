// 签名外发（回调 / webhook 送达共用）：业务方能验"真是中枢发的"，失败带退避重试。
// 验签方式：sig = "sha256=" + HMAC-SHA256(secret, `${timestamp}.${body}`)，secret = 触发方自己的 token（admin 触发用 server.token）。
// 标签 sha256= 是算法名、全框架统一（非版本号）；回调时间戳是【毫秒】，构造比工具签名短（无 method/path/主体）。
// 拆分 server.ts 的核心叶子之一——被 engine（finish/spawnDelivery）与 tools-runtime（notifyApproval）共用，自身不依赖二者。
import { channelSendFor } from './channels';
import type { Job } from '../core/contracts/types';
import { signBody } from '../core/platform/signing';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { AppConfig } from '../core/config/config';
import { requireServerToken } from '../core/platform/server-token';

export { signBody };

export interface OutboundRuntimeDeps {
  cfg: Pick<AppConfig, 'server' | 'brand' | 'alerts'>;
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  channelSendFor: typeof channelSendFor;
  fetch: typeof fetch;
}

export function outboundRuntimeDepsFor(input: {
  cfg: Pick<AppConfig, 'server' | 'brand' | 'alerts'>;
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  channelSendFor?: typeof channelSendFor;
  fetch?: typeof fetch;
}): OutboundRuntimeDeps {
  return {
    cfg: input.cfg,
    configStore: input.configStore,
    stateStore: input.stateStore,
    now: input.now,
    sleep: input.sleep,
    channelSendFor: input.channelSendFor ?? channelSendFor,
    fetch: input.fetch ?? fetch,
  };
}

/** 该 job 的外发签名密钥：接入方触发用其 client token（对方已持有，无需另发密钥）；否则用 server.token。 */
export async function secretForJobWithDeps(deps: Pick<OutboundRuntimeDeps, 'cfg' | 'configStore'>, job: Job): Promise<string> {
  const config = deps.configStore;
  if (job.client_app_id && config) {
    const c = await config.clients.get(job.client_app_id).catch(() => null);
    if (c) return c.token;
  }
  // 聊天来源任务没有接入方 ID：用该入口的票据接入方 token 签——业务侧本来就持有这把钥匙
  // （签票/验票/收回调一钥贯通），绝不能坠落到 server 管理 token（业务侧无法验签）
  const entryKey = String((job.metadata ?? {})['chat_entry'] ?? '');
  if (entryKey && config) {
    const e = await config.chatEntries.get(entryKey).catch(() => null);
    if (e?.ticket_client) {
      const c = await config.clients.get(e.ticket_client).catch(() => null);
      if (c) return c.token;
    }
  }
  return requireServerToken(deps.cfg.server.token, '签署任务回调');
}

const OUTBOUND_BACKOFF_MS = [0, 2000, 10_000]; // 共 3 次尝试
export async function postSignedWithDeps(deps: Pick<OutboundRuntimeDeps, 'stateStore' | 'now' | 'sleep' | 'fetch'>, url: string, payload: unknown, secret: string, audit: { job_id: string; request_id: string; event: string }): Promise<boolean> {
  const body = JSON.stringify(payload);
  for (let i = 0; i < OUTBOUND_BACKOFF_MS.length; i++) {
    if (OUTBOUND_BACKOFF_MS[i]! > 0) await deps.sleep(OUTBOUND_BACKOFF_MS[i]!);
    const ts = Date.now().toString();
    try {
      const resp = await deps.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bailing-timestamp': ts,
          'x-bailing-signature': `sha256=${signBody(secret, ts, body)}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        await deps.stateStore.appendAudit({ ts: deps.now(), ...audit, detail: { url, ok: true, attempt: i + 1 } });
        return true;
      }
      if (resp.status < 500 && resp.status !== 429) { // 4xx 是对方明确拒绝，重试无意义
        await deps.stateStore.appendAudit({ ts: deps.now(), ...audit, detail: { url, ok: false, status: resp.status, attempt: i + 1, final: true } });
        return false;
      }
    } catch { /* 网络/超时 → 下一轮 */ }
  }
  await deps.stateStore.appendAudit({ ts: deps.now(), ...audit, detail: { url, ok: false, attempt: OUTBOUND_BACKOFF_MS.length, final: true, error: '重试耗尽' } });
  return false;
}

export async function fireCallbackWithDeps(deps: OutboundRuntimeDeps, url: string, job: Job): Promise<void> {
  await postSignedWithDeps(deps, url, job, await secretForJobWithDeps(deps, job), { job_id: job.job_id, request_id: job.request_id, event: 'callback' });
}

// ---- 运行告警：监控/spec 变更等内部事件 → 经渠道出站推送（bz_alert_rules 配「通知谁/什么事/走哪个渠道」）。带冷却去重。----
// 渠道规则使用 channelSend 直推（复用渠道凭证），通用 webhook 使用签名 HTTP 直发；
// 两种出口都不创建需要执行器认领的任务，避免告警链路因执行器离线而积压。
const alertSentAt = new Map<string, number>();
export async function sendAlertWithDeps(deps: OutboundRuntimeDeps, key: string, text: string): Promise<void> {
  const rules = deps.configStore ? await deps.configStore.alertRules.matching(key).catch(() => []) : [];
  const a = deps.cfg.alerts;
  const webhookUrl = (a && a.type === 'webhook' && a.url) ? a.url : '';
  // 冷却：同一事件 key 窗口内只吵一次（取命中规则最小冷却，否则 config 或 60min）。无出口也走冷却，避免审计刷屏。
  const cooldownMin = rules.length ? Math.min(...rules.map((r) => r.cooldown_min)) : (a?.cooldown_min ?? 60);
  if (Date.now() - (alertSentAt.get(key) ?? 0) < cooldownMin * 60_000) return;
  alertSentAt.set(key, Date.now());
  await deps.stateStore.appendAudit({ ts: deps.now(), job_id: '-', request_id: 'monitor', event: 'alert', detail: { key, text: text.slice(0, 300), rules: rules.length, webhook: !!webhookUrl } });
  if (!rules.length && !webhookUrl) return; // 未配任何出口：只留审计，优雅降级（绝不建幽灵任务）
  const content = `【${deps.cfg.brand.name}】运行告警\n${text}\n\n—— ${deps.cfg.brand.name}`;
  // 通用 webhook 直发到部署方自有接收端。
  if (webhookUrl) {
    void postSignedWithDeps(deps, webhookUrl, { kind: 'alert', key, message: content }, requireServerToken(deps.cfg.server.token, '签署告警 webhook'), { job_id: '-', request_id: 'monitor', event: 'alert_webhook' });
  }
  // 渠道出站：按规则把告警推给各收件人（channelSend 直推，不建 job）
  for (const rule of rules) {
    for (const to of rule.recipients) {
      const r = await deps.channelSendFor(deps.configStore, rule.channel, to, content).catch((e) => ({ ok: false, error: String(e) }));
      await deps.stateStore.appendAudit({ ts: deps.now(), job_id: '-', request_id: 'monitor',
        event: r.ok ? 'alert_sent' : 'alert_send_error',
        detail: { key, channel: rule.channel, to, ...(r.ok ? {} : { error: (r as { error?: string }).error }) } }).catch(() => undefined);
    }
  }
}
