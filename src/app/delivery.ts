// 送达层：把任务终态结果交给业务侧或用户侧。
// engine 只负责在 finish 后触发本模块；本模块负责 webhook、内置渠道直投、自定义 notify 执行器子任务。
import { randomUUID } from 'node:crypto';
import { outboundRuntimeDepsFor, postSignedWithDeps, postSignedNotificationWithDeps, secretForJobWithDeps, sendAlertWithDeps, type NotificationSendOutcome } from './outbound';
import { channelScopeKey, channelSendFor } from './channels';
import { extractAttachments } from '../core/platform/content';
import { defaultTargetRegistry, type TargetRegistry } from '../core/targets/registry';
import { routeDeliveryConfig } from '../core/config/route-config';
import type { Job } from '../core/contracts/types';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { notificationBackgroundWorkFor } from '../core/runtime/notification-background-work';

export interface DeliveryDeps {
  cfg: AppConfig;
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  targetRegistry?: TargetRegistry;
  channelSendFor?: typeof channelSendFor;
}

/** Verify the original notification binding when a concurrent insert or its ACK is lost. */
export async function createNotificationChildOnce(state: RuntimeStateStore, child: Job): Promise<Job> {
  const matches = (existing: Job) => existing.source === 'delivery' && existing.target === child.target
    && existing.input === child.input && existing.metadata?.parent_job_id === child.metadata?.parent_job_id
    && existing.metadata?.approval_id === child.metadata?.approval_id;
  const existing = await state.findByRequestId(child.request_id);
  if (existing) {
    if (!matches(existing)) throw new Error('notification_child_binding_conflict');
    return existing;
  }
  try { await state.createJob(child); return child; }
  catch (error) {
    const saved = await state.findByRequestId(child.request_id);
    if (!saved || !matches(saved)) throw error;
    return saved;
  }
}

/** Durable result delivery; never launches or requeues the business parent. */
export async function deliverNotificationFor(deps: DeliveryDeps, parent: Job, eventId: string, brandName = deps.cfg.brand.name): Promise<NotificationSendOutcome> {
  if (parent.source === 'delivery' || parent.metadata?.no_delivery) return { status: 'skipped' };
  const outbound = outboundRuntimeDepsFor({ ...deps, channelSendFor: deps.channelSendFor });
  const d = routeDeliveryConfig(parent.dispatch?.delivery);
  const nativeWecom = parent.status === 'done' && parent.source?.startsWith('wecom:');
  const result = parent.result ?? {};
  const rawText = typeof result.text === 'string' ? result.text : parent.raw_result || '';
  const content = parent.status === 'error'
    ? `【${parent.dispatch?.route_name || '任务'}】执行失败：${String(parent.error ?? '未知错误').slice(0, 500)}`
    : renderDeliveryMessage(parent, brandName);
  const wecomRecipient = String(parent.metadata?.wecom_userid ?? '').trim();
  const useWecom = nativeWecom && !!wecomRecipient && !!rawText;
  if (!useWecom && (!d?.type || !content || (parent.status === 'error' && d.type !== 'webhook'))) return { status: 'skipped' };
  if (!useWecom && d?.type === 'webhook') {
    const url = String(d.url ?? '').trim();
    if (!url) return { status: 'skipped', error: 'Webhook destination missing' };
    return postSignedNotificationWithDeps(outbound, url, {
      kind: 'delivery', job_id: parent.job_id, request_id: parent.request_id,
      route_name: parent.dispatch?.route_name ?? '', status: parent.status, message: content,
      text: typeof result.text === 'string' ? result.text : null,
      attachments: extractAttachments(typeof result.text === 'string' ? result.text : ''),
      report: result.report ?? null, error: parent.error ?? null, metadata: parent.metadata ?? {}, finished_at: parent.updated_at,
    }, await secretForJobWithDeps(outbound, parent), eventId,
    { job_id: parent.job_id, request_id: parent.request_id, event: 'delivery_webhook' });
  }
  // Native replies must survive more than one approved continuation of a Job.
  // Deduplicate one saved terminal event, not all future replies from that Job.
  // Explicit delivery routes retain their existing once-per-parent policy.
  const requestId = useWecom ? `deliver_${eventId}` : `deliver_${parent.job_id}`;
  if (useWecom || d?.type === 'channel') {
    const channel = useWecom ? parent.source!.slice('wecom:'.length) : String(d!.channel ?? '').trim();
    const raw = useWecom ? wecomRecipient : (d?.to_field ? parent.metadata?.[String(d.to_field)] : undefined);
    const parsed = (Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split('|')).map(value => value.trim()).filter(Boolean);
    const recipients = [...new Set(parsed.length ? parsed : String(d?.to ?? '').split('|').map(value => value.trim()).filter(Boolean))].slice(0, 1000);
    if (!channel || !recipients.length) return { status: 'skipped', error: 'Channel destination missing' };
    const previous = await deps.stateStore.findByRequestId(requestId);
    if (previous) {
      if (previous.source !== 'delivery' || previous.metadata?.parent_job_id !== parent.job_id) return { status: 'failed', error: 'notification_child_binding_conflict' };
      if (previous.status === 'done') return { status: 'skipped', error: 'Original delivery already recorded' };
      if (previous.metadata?.notification_event_id !== eventId) return { status: 'failed', error: 'Original delivery failed; use its delivery dead letter' };
    }
    const text = rawText.trim() ? rawText : content;
    const send = deps.channelSendFor ?? channelSendFor;
    const sent = await send(deps.configStore, channel, recipients.join('|'), text)
      .catch(() => ({ ok: false, error: 'Channel acknowledgement unavailable', mayHaveCommitted: true }));
    const child: Job = { job_id: previous?.job_id ?? randomUUID(), request_id: requestId, status: sent.ok ? 'done' : 'error',
      target: 'channel-send', profile: 'delivery', project: '', source: 'delivery',
      input_preview: text.slice(0, 200), input: text,
      result: sent.ok ? { text, channel, to: recipients } : undefined, error: sent.ok ? undefined : sent.error,
      metadata: { parent_job_id: parent.job_id, parent_request_id: parent.request_id, notification_event_id: eventId,
        outbound: true, via: 'delivery', channel, recipients: recipients.length, ...(recipients.length === 1 ? { recipient: recipients[0] } : {}) },
      created_at: previous?.created_at ?? deps.now(), updated_at: deps.now() };
    if (previous) await deps.stateStore.updateJob(previous.job_id, { status: child.status, result: child.result, error: child.error });
    else await createNotificationChildOnce(deps.stateStore, child);
    if (sent.ok) {
      // History is observability; a history failure must not resend an acknowledged message.
      const config = deps.configStore;
      if (config) {
        const ch = await config.channels.get(channel).catch(() => null);
        if (ch) for (const recipient of recipients) {
          try {
            const principal = (ch.kind === 'wecom' ? `wxuid:${recipient}` : `${ch.kind}:${recipient}`).slice(0, 64);
            const thread = await config.conversations.resolveThread(ch.route_key, channelScopeKey(ch.kind, ch.name, recipient), principal);
            await config.conversations.appendMessage({ thread_id: thread, direction: 'out', channel: 'delivery', principal_id: principal, job_id: parent.job_id, content: text });
          } catch { /* acknowledged channel result is retained */ }
        }
      }
      return { status: 'completed' };
    }
    const recipientLabel = recipients.length === 1 ? recipients[0] : `${recipients.length}人`;
    void sendAlertWithDeps(outbound, `delivery_failed_${channel}`,
      `${useWecom ? '渠道回流送达失败' : '渠道送达失败'}（${channel} → ${recipientLabel}）：${String(sent.error ?? '未知').slice(0, 200)}。收件人可能未收到，关联任务 ${parent.job_id}。`)
      .catch(() => { /* Best-effort alert is tracked for close; it cannot change delivery recovery. */ });
    if (deps.configStore) await deps.configStore.deliveryDlq.record({ parentJobId: parent.job_id, channel,
      recipient: recipients.join('|'), content: text, error: sent.error ?? 'Channel delivery failed', deliveryKind: 'native_channel', eventId });
    return { status: sent.mayHaveCommitted ? 'uncertain' : 'failed', error: sent.error ?? 'Channel delivery failed' };
  }
  const target = `${d!.type}-notify`;
  const definition = (deps.targetRegistry ?? defaultTargetRegistry).get(target);
  const to = String((d?.to_field ? parent.metadata?.[String(d.to_field)] : undefined) || d?.to || '').trim();
  if (!definition || definition.kind !== 'executor' || !definition.enabled || !to) return { status: 'skipped', error: 'Notification executor or recipient unavailable' };
  const existing = await deps.stateStore.findByRequestId(requestId);
  if (existing && existing.metadata?.notification_event_id !== eventId) {
    if (existing.source !== 'delivery' || existing.metadata?.parent_job_id !== parent.job_id) return { status: 'failed', error: 'notification_child_binding_conflict' };
    // Preserve the existing deliver_<parent> policy across a legitimate business rerun.
    return { status: 'skipped', error: 'Original delivery already queued' };
  }
  await createNotificationChildOnce(deps.stateStore, { job_id: randomUUID(), request_id: requestId, status: 'queued',
    target, profile: 'delivery', project: '', source: 'delivery', thread_id: parent.thread_id, session_id: randomUUID(),
    input_preview: content.slice(0, 200), input: content, dispatch: { target_config: d! },
    metadata: { to, parent_job_id: parent.job_id, parent_request_id: parent.request_id, notification_event_id: eventId },
    created_at: deps.now(), updated_at: deps.now() });
  return { status: 'completed' };
}

/**
 * ⑤送达层（插座）：按 delivery.type 解析承接方——
 *   - `webhook`：中枢内置，签名 POST 到 delivery.url（业务方验签同回调）；
 *   - `channel`：中枢内置，经 bz_channels 出站凭证 channelSend 把结果直推 delivery.channel 的指定收件人；
 *   - 其余类型 X：按约定由执行器目标 `X-notify` 承接（如 wecom → wecom-notify）。
 * 收件人解析：metadata[to_field] 优先，缺省回落 delivery.to；都没有则跳过并记审计。
 */
export async function spawnDeliveryJobFor(deps: DeliveryDeps, parent: Job): Promise<void> {
  const sendChannel = deps.channelSendFor ?? channelSendFor;
  const outboundRuntime = outboundRuntimeDepsFor({
    cfg: deps.cfg,
    configStore: deps.configStore,
    stateStore: deps.stateStore,
    now: deps.now,
    sleep: deps.sleep,
    channelSendFor: sendChannel,
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
      const sent = await sendChannel(deps.configStore, channelName, recipient, String(text));
      await deps.stateStore.appendAudit({ ts: deps.now(), job_id: parent.job_id, request_id: parent.request_id, event: sent.ok ? 'channel_delivered' : 'channel_delivery_error', detail: { channel: channelName, to: recipient, ...(sent.ok ? {} : { error: sent.error }) } });
      if (!sent.ok) {
        void sendAlertWithDeps(outboundRuntime, `delivery_failed_${channelName}`, `渠道回流送达失败（${channelName} → ${recipient}）：${String(sent.error ?? '未知').slice(0, 200)}。用户可能未收到结果，关联任务 ${parent.job_id}。`).catch(() => { /* 告警失败不阻塞 */ });
        if (deps.configStore) void notificationBackgroundWorkFor(deps.stateStore).track('delivery-dlq', () => deps.configStore!.deliveryDlq.record({ parentJobId: parent.job_id, channel: channelName, recipient, content: String(text), error: String(sent.error ?? ''), deliveryKind: 'native_channel' }));
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
    const sent = await sendChannel(deps.configStore, channelName, recipients.join('|'), String(body));
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
      if (deps.configStore) void notificationBackgroundWorkFor(deps.stateStore).track('delivery-dlq', () => deps.configStore!.deliveryDlq.record({ parentJobId: parent.job_id, channel: channelName, recipient: recipients.join('|'), content: String(body), error: String(sent.error ?? ''), deliveryKind: 'native_channel' }));
    }
    return;
  }

  // 执行器渠道：type → `${type}-notify` 目标（注册表里必须存在且为 executor）
  const targetName = `${type}-notify`;
  const def = (deps.targetRegistry ?? defaultTargetRegistry).get(targetName);
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
