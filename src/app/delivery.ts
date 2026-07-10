// 送达层：把任务终态结果交给业务侧或用户侧。
// engine 只负责在 finish 后触发本模块；本模块负责 webhook、内置渠道直投、自定义 notify 执行器子任务。
import { randomUUID } from 'node:crypto';
import { outboundRuntimeDepsFor, postSignedWithDeps, secretForJobWithDeps, sendAlertWithDeps } from './outbound';
import { channelScopeKey, channelSendFor } from './channels';
import { extractAttachments } from '../core/platform/content';
import { getTargetDef } from '../core/targets/registry';
import { routeDeliveryConfig } from '../core/config/route-config';
import type { Job } from '../core/contracts/types';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export interface DeliveryDeps {
  cfg: AppConfig;
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
}

/**
 * ⑤送达层（插座）：按 delivery.type 解析承接方——
 *   - `webhook`：中枢内置，签名 POST 到 delivery.url（业务方验签同回调）；
 *   - `channel`：中枢内置，经 bz_channels 出站凭证 channelSend 把结果直推 delivery.channel 的指定收件人；
 *   - 其余类型 X：按约定由执行器目标 `X-notify` 承接（如 wecom → wecom-notify）。
 * 收件人解析：metadata[to_field] 优先，缺省回落 delivery.to；都没有则跳过并记审计。
 */
export async function spawnDeliveryJobFor(deps: DeliveryDeps, parent: Job): Promise<void> {
  const outboundRuntime = outboundRuntimeDepsFor({
    cfg: deps.cfg,
    configStore: deps.configStore,
    stateStore: deps.stateStore,
    now: deps.now,
    sleep: deps.sleep,
  });
  if (parent.source === 'delivery') return; // 投递任务自身绝不再投递（防递归）
  if ((parent.metadata ?? {})['no_delivery']) {
    await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: 'delivery_skipped', detail: { reason: '调用方声明 no_delivery' } });
    return;
  }

  // 渠道原生回流：企微等渠道入站任务的异步完成（审批批准后重跑 / 崩溃恢复——前台被动窗口与长轮询都已离场）。
  if (parent.status === 'done' && typeof parent.source === 'string' && parent.source.startsWith('wecom:')) {
    const channelName = parent.source.slice('wecom:'.length);
    const recipient = String((parent.metadata ?? {})['wecom_userid'] ?? '').trim();
    const r = (parent.result ?? {}) as Record<string, unknown>;
    const text = (typeof r['text'] === 'string' && r['text']) ? (r['text'] as string) : (parent.raw_result || '');
    if (channelName && recipient && text) {
      const sent = await channelSendFor(deps.configStore, channelName, recipient, String(text));
      await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: sent.ok ? 'channel_delivered' : 'channel_delivery_error', detail: { channel: channelName, to: recipient, ...(sent.ok ? {} : { error: sent.error }) } });
      if (!sent.ok) {
        void sendAlertWithDeps(outboundRuntime, `delivery_failed_${channelName}`, `渠道回流送达失败（${channelName} → ${recipient}）：${String(sent.error ?? '未知').slice(0, 200)}。用户可能未收到结果，关联任务 ${parent.job_id}。`).catch(() => { /* 告警失败不阻塞 */ });
        void deps.configStore?.deliveryDlq.record({ parentJobId: parent.job_id, channel: channelName, recipient, content: String(text), error: String(sent.error ?? '') }).catch(() => undefined);
      }
      return;
    }
    await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: 'channel_delivery_skipped', detail: { channel: channelName, to: recipient, reason: !text ? '无可投递正文' : (!recipient ? '无收件人（metadata.wecom_userid 空）' : '无渠道名') } });
    // 落审计后继续往下：若该渠道路由另配了 webhook 兜底则照走，否则下面 !d||!type 自然 return。
  }

  const d = routeDeliveryConfig(parent.dispatch?.delivery);
  const type = d?.type ?? '';
  if (!d || !type) return;
  // 失败结果只走 webhook（机器对账渠道）：人渠道（企微等）不推失败免噪音
  if (parent.status === 'error' && type !== 'webhook') {
    await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: 'delivery_skipped', detail: { reason: '失败结果仅回调 webhook，不推人渠道' } });
    return;
  }
  const content = parent.status === 'error'
    ? `【${parent.dispatch?.route_name || '任务'}】执行失败：${String(parent.error ?? '未知错误').slice(0, 500)}`
    : renderDeliveryMessage(parent, deps.cfg.brand.name);
  if (!content) {
    await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: 'delivery_skipped', detail: { reason: '结果无可投递内容' } });
    return;
  }

  // webhook：中枢内置直发（带签名+重试），不需要执行器
  if (type === 'webhook') {
    const url = String(d['url'] ?? '').trim();
    if (!url) {
      await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: 'delivery_skipped', detail: { reason: 'webhook 送达缺 url' } });
      return;
    }
    const r = (parent.result ?? {}) as Record<string, unknown>;
    const payload = {
      kind: 'delivery', job_id: parent.job_id, request_id: parent.request_id,
      route_name: parent.dispatch?.route_name ?? '',
      status: parent.status,
      message: content,
      text: typeof r['text'] === 'string' ? r['text'] : null,
      attachments: extractAttachments(typeof r['text'] === 'string' ? r['text'] : ''),
      report: r['report'] ?? null,
      error: parent.error ?? null,
      metadata: parent.metadata ?? {},
      finished_at: parent.updated_at ?? null,
    };
    void postSignedWithDeps(outboundRuntime, url, payload, await secretForJobWithDeps(outboundRuntime, parent), { job_id: parent.job_id, request_id: parent.request_id, event: 'delivery_webhook' });
    return;
  }

  if (type === 'channel') {
    const channelName = String(d['channel'] ?? '').trim();
    const toField = String(d['to_field'] ?? '').trim();
    const metaVal = toField ? (parent.metadata ?? {})[toField] : undefined;
    const rawList = Array.isArray(metaVal) ? metaVal.map((x) => String(x)) : String(metaVal ?? '').split('|');
    const fromMeta = rawList.map((x) => x.trim()).filter(Boolean);
    const recipients = [...new Set((fromMeta.length ? fromMeta : String(d['to'] ?? '').split('|').map((x) => x.trim()).filter(Boolean)))].slice(0, 1000);
    if (!channelName || !recipients.length) {
      await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: 'delivery_skipped', detail: { reason: !channelName ? 'channel 送达缺 delivery.channel' : `无收件人（metadata.${toField || '?'} 与 delivery.to 均空）` } });
      return;
    }
    const reqId = `deliver_${parent.job_id}`;
    if (await deps.stateStore.findByRequestId(reqId)) return; // 幂等：同一父任务只投一次（防重跑/恢复重复推）
    const ch = deps.configStore ? await deps.configStore.channels.get(channelName) : null;
    if (!ch || !ch.enabled) {
      await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: 'delivery_skipped', detail: { reason: `渠道 ${channelName} 不存在或已停用` } });
      return;
    }
    const r0 = (parent.result ?? {}) as Record<string, unknown>;
    const body = (typeof r0['text'] === 'string' && (r0['text'] as string).trim()) ? (r0['text'] as string) : content;
    const sent = await channelSendFor(deps.configStore, channelName, recipients.join('|'), String(body));
    let threadId: number | undefined;
    if (sent.ok && deps.configStore) {
      const config = deps.configStore;
      try {
        const tids = await Promise.all(recipients.map(async (rcpt) => {
          const scope = channelScopeKey(ch.kind, ch.name, rcpt);
          const pid = (ch.kind === 'wecom' ? `wxuid:${rcpt}` : `${ch.kind}:${rcpt}`).slice(0, 64);
          const tid = await config.conversations.resolveThread(ch.route_key, scope, pid);
          await config.conversations.appendMessage({ thread_id: tid, direction: 'out', channel: 'delivery', principal_id: pid, job_id: parent.job_id, content: String(body) });
          return tid;
        }));
        threadId = tids[0];
      } catch (e) {
        await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: 'ledger_error', detail: { stage: 'delivery_channel', error: String(e).slice(0, 200) } }).catch(() => undefined);
      }
    }
    const single = recipients.length === 1;
    await deps.stateStore.createJob({
      job_id: randomUUID(), request_id: reqId, status: sent.ok ? 'done' : 'error',
      target: 'channel-send', profile: 'delivery', project: '', source: 'delivery', thread_id: threadId,
      input_preview: String(body).slice(0, 200), input: String(body),
      result: sent.ok ? { text: String(body), channel: channelName, to: single ? recipients[0] : recipients } : undefined,
      error: sent.ok ? undefined : (sent.error ?? '送达失败'),
      metadata: { outbound: true, via: 'delivery', channel: channelName, recipients: recipients.length, ...(single ? { recipient: recipients[0] } : {}), parent_job_id: parent.job_id, parent_request_id: parent.request_id },
      created_at: deps.now(), updated_at: deps.now(),
    }).catch(() => undefined);
    await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: sent.ok ? 'channel_delivered' : 'channel_delivery_error', detail: { channel: channelName, to: single ? recipients[0] : `${recipients.length}人`, via: 'delivery', ...(sent.ok ? { thread_id: threadId ?? null } : { error: sent.error }) } });
    if (!sent.ok) {
      void sendAlertWithDeps(outboundRuntime, `delivery_failed_${channelName}`, `渠道送达失败（${channelName} → ${single ? recipients[0] : recipients.length + '人'}）：${String(sent.error ?? '未知').slice(0, 200)}。收件人可能未收到，关联任务 ${parent.job_id}。`).catch(() => { /* 告警失败不阻塞 */ });
      void deps.configStore?.deliveryDlq.record({ parentJobId: parent.job_id, channel: channelName, recipient: recipients.join('|'), content: String(body), error: String(sent.error ?? '') }).catch(() => undefined);
    }
    return;
  }

  // 执行器渠道：type → `${type}-notify` 目标（注册表里必须存在且为 executor）
  const targetName = `${type}-notify`;
  const def = getTargetDef(targetName);
  if (!def || def.kind !== 'executor' || !def.enabled) {
    await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: 'delivery_skipped', detail: { reason: `未注册的送达类型 ${type}（需要执行器目标 ${targetName}）` } });
    return;
  }
  const reqId = `deliver_${parent.job_id}`;
  if (await deps.stateStore.findByRequestId(reqId)) return; // 幂等
  const toField = String(d['to_field'] ?? '').trim();
  const fromMeta = toField ? String((parent.metadata ?? {})[toField] ?? '').trim() : '';
  const to = fromMeta || String(d['to'] ?? '').trim();
  if (!to) {
    await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: 'delivery_skipped', detail: { reason: `无收件人（metadata.${toField || '?'} 与 delivery.to 均空）` } });
    return;
  }
  const child: Job = {
    job_id: randomUUID(), request_id: reqId, status: 'queued',
    target: targetName, profile: 'delivery', project: '', source: 'delivery',
    thread_id: parent.thread_id, session_id: randomUUID(),
    input_preview: content.slice(0, 200), input: content,
    dispatch: { target_config: d },
    metadata: { to, parent_job_id: parent.job_id, parent_request_id: parent.request_id },
    created_at: deps.now(), updated_at: deps.now(),
  };
  await deps.stateStore.createJob(child);
  await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: 'delivery_queued', detail: { type, to, child_job: child.job_id } });
}

/** 结果 → 正式通知文案（无 emoji，落款用 config.brand.name，部署方可改）。报告型取要点，文本型截断原文。 */
export function renderDeliveryMessage(job: Job, brandName = '百灵中枢'): string {
  const r = (job.result ?? {}) as Record<string, unknown>;
  const title = job.dispatch?.route_name || '任务';
  const lines: string[] = [];
  const report = r['report'] as Record<string, unknown> | undefined;
  if (report) {
    lines.push(`【${title}】结果通知`);
    if (report['summary']) lines.push(`结论：${String(report['summary'])}`);
    const sev = report['severity']; const cat = report['category'];
    if (sev || cat) lines.push(`等级：${String(sev ?? '-')}　分类：${String(cat ?? '-')}`);
    const ev = Array.isArray(report['evidence']) ? (report['evidence'] as unknown[]) : [];
    if (ev.length) {
      lines.push('问题点：');
      ev.slice(0, 8).forEach((e, i) => lines.push(`${i + 1}. ${String(e)}`));
      if (ev.length > 8) lines.push(`（其余 ${ev.length - 8} 条见后台 job ${job.job_id}）`);
    }
    if (report['suggested_next_step']) lines.push(`建议：${String(report['suggested_next_step'])}`);
  } else if (typeof r['text'] === 'string' && r['text']) {
    lines.push(`【${title}】结果通知`, String(r['text']).slice(0, 1800));
  } else {
    return '';
  }
  lines.push('', `—— ${brandName}`);
  return lines.join('\n');
}
