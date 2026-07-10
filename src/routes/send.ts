// 业务主动出站入口：POST /send —— 接入方/admin 带 token 调「把这条消息经渠道X发给用户Y」。
// 与 /run 是兄弟而非分支：/run=触发大脑(记 in、跑 LLM、闸 allowed_routes)；/send=注入一条回复方消息(记 out、不跑大脑、闸 allowed_channels)。
//
// 三件事一次做齐：① channelSend 投递；② 作为 out(回复方)轮次写进「该渠道路由下、收件人的那个 thread」(入历史，用户追问时大脑读得到)；③ 落一条 job(任务可见)。
// 纪律：
//   · 先投递、成功才写历史——绝不把"用户没收到的消息"记进会话(否则大脑会引用一条用户从没见过的消息)。
//   · 记 direction='out'(渲染为「回复」)，不是 'in'——业务在"对用户说话"，记成 in 会让大脑以为是用户自己说的，角色全乱。
//   · scope 走 channelScopeKey 共享函数，与企微入站逐字一致——差一字符就落到别的 thread，等于没接上历史。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readBody, send } from '../app/http';
import { channelScopeKey, channelSendFor, type ChannelMessage, type ChannelCard } from '../app/channels';
import { type Principal, clientAllowsChannel, rateLimitedFor } from '../app/auth';
import type { Job } from '../core/contracts/types';
import type { AppConfig } from '../core/config/config';
import type { RuntimeActor, RuntimeContext, RuntimeSource } from '../core/edition';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

interface RuntimeContextInput {
  source: RuntimeSource;
  requestId: string;
  principal?: Principal | null;
  actor?: RuntimeActor;
}

export interface SendApiDeps {
  cfg: Pick<AppConfig, 'defaultProfile'>;
  isPaused: () => boolean;
  runtimeContextFor: (input: RuntimeContextInput) => Promise<RuntimeContext>;
  runtimeStoresFor: (ctx: RuntimeContext) => { state: RuntimeStateStore; config: ConfigStoreContract | null };
  now: () => string;
  channelSendFor: typeof channelSendFor;
}

const MAX_TEXT = 2000;        // 正文上限（企微文本约 2048 字节，留余量；超长直接 400 比让渠道侧报错清楚）
const MAX_ATTACH = 9;         // 单次图片/文件各自条数上限（每个附件一次企微发送，封顶防滥用）
const MAX_RECIPIENTS = 1000;  // 企微 touser 上限；批量通知一次发多人（数组或 "a|b|c"），省 N 次往返与 N 次限速

export async function handleSendFor(deps: SendApiDeps, req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
  if (deps.isPaused()) { send(res, 503, { status: 'paused' }); return; }
  const body = (await readBody(req)) as Partial<{ request_id: string; channel: string; to: unknown; text: string; images: unknown; files: unknown; card: unknown }>;
  const requestId = String(body.request_id ?? '').trim();
  const channelName = String(body.channel ?? '').trim();
  // 收件人：支持单个 / 数组 / "a|b|c"。去重 + 封顶。一次多人 = 渠道原生合并发，一次调用、占一次限速。
  const rawTo = Array.isArray(body.to) ? body.to.map((x) => String(x)) : String(body.to ?? '').split('|');
  const recipients = [...new Set(rawTo.map((x) => x.trim()).filter(Boolean))].slice(0, MAX_RECIPIENTS);
  const text = String(body.text ?? '');
  // 附件（URL 制）：images=[url...]；files=[{url,name?}...]。中枢拉取→上传渠道→投递。各自封顶 MAX_ATTACH。
  const images = (Array.isArray(body.images) ? body.images.map((u) => String(u).trim()).filter(Boolean) : []).slice(0, MAX_ATTACH);
  const files = (Array.isArray(body.files) ? body.files.filter((f) => f && typeof f === 'object' && (f as { url?: unknown }).url)
    .map((f) => ({ url: String((f as { url: unknown }).url).trim(), name: (f as { name?: unknown }).name ? String((f as { name: unknown }).name).slice(0, 120) : undefined })) : []).slice(0, MAX_ATTACH);
  // 卡片（企微 textcard）：仅企微类渠道生效；需 title + url。不支持卡片的渠道回退发 text。
  const cardIn = body.card && typeof body.card === 'object' ? (body.card as Record<string, unknown>) : null;
  let card: ChannelCard | undefined;
  if (cardIn) {
    const ctitle = String(cardIn['title'] ?? '').trim();
    const curl = String(cardIn['url'] ?? '').trim();
    if (!ctitle || !curl) { send(res, 400, { error: 'card 需要 title 和 url' }); return; }
    card = { type: 'textcard', title: ctitle, description: String(cardIn['description'] ?? ''), url: curl, btntxt: cardIn['btntxt'] ? String(cardIn['btntxt']) : undefined };
  }
  if (!requestId || !channelName || !recipients.length) { send(res, 400, { error: 'request_id / channel / to 必填' }); return; }
  if (!text.trim() && !images.length && !files.length && !card) { send(res, 400, { error: 'text / images / files / card 至少给一项' }); return; }
  if (text.length > MAX_TEXT) { send(res, 400, { error: `text 超过 ${MAX_TEXT} 字上限` }); return; }

  const ctx = await deps.runtimeContextFor({ source: 'send', requestId, principal });
  const { state: store, config: cfgStore } = deps.runtimeStoresFor(ctx);
  if (!cfgStore) { send(res, 400, { error: '出站需要 mysql 后端' }); return; }

  // 身份闸：仅接入方 token 或管理身份。接入方还要过「渠道白名单 + 限速」（admin 不限，与 /run 的 allowed_routes 一致）。
  const client = principal.kind === 'client' ? principal.client : null;
  if (!client && principal.kind !== 'admin') { send(res, 403, { error: '需接入方 token 或管理身份' }); return; }
  if (client) {
    if (!clientAllowsChannel(client, channelName)) { send(res, 403, { error: `接入方 ${client.app_id} 无权向渠道 ${channelName} 主动推送（需在中枢后台「接入方」授权该渠道）` }); return; }
    if (await rateLimitedFor(cfgStore, client)) { send(res, 429, { error: `超出限速（${client.rate_limit_per_min}/分钟），请稍后重试同 request_id` }); return; }
  }
  const source = client ? client.app_id : 'admin';

  // 幂等：同一 request_id 不重发（撞自己的 id 才认；失败后请换新 request_id 重试，不会复发旧的）
  const existing = await store.findByRequestId(requestId);
  if (existing) {
    if (client && existing.client_app_id !== client.app_id) { send(res, 409, { error: 'request_id 与其他接入方冲突，请换用带自身前缀的 request_id' }); return; }
    send(res, 200, { ok: existing.status === 'done', job_id: existing.job_id, status: existing.status, request_id: requestId, deduped: true });
    return;
  }

  const ch = await cfgStore.channels.get(channelName);
  if (!ch || !ch.enabled) { send(res, 400, { error: `渠道 ${channelName} 不存在或已停用` }); return; }

  // 入历史的内容：文字（无文字则用卡片标题作降级）+ 图片(markdown 图，控制台可渲染、大脑能"看见"发过图) + 文件(链接)。投递成功才写。
  const histParts: string[] = [];
  if (text.trim()) histParts.push(text);
  else if (card) histParts.push(card.title);
  for (const u of images) histParts.push(`![](${u})`);
  for (const f of files) histParts.push(`[附件：${f.name || '文件'}](${f.url})`);
  const content = histParts.join('\n') || '（空）';
  const message: ChannelMessage = { text: text.trim() || undefined, images, files, card };

  // 先投递——成功才入历史。多收件人用渠道原生 "a|b|c" 合并，一次调用。channelSend 内校验凭证、拉取上传附件、发卡片/文字/附件。
  const r = await deps.channelSendFor(cfgStore, channelName, recipients.join('|'), message).catch((e) => ({ ok: false, error: String(e) } as { ok: boolean; error?: string }));

  const jobId = randomUUID();
  const ts = deps.now();
  let threadId: number | undefined;
  if (r.ok) {
    // 入历史：每个收件人各自的 thread 都记一条 out（谁回复大脑都接得上）。并发写，总账故障不回滚已送达、降级审计即可。
    try {
      const tids = await Promise.all(recipients.map(async (rcpt) => {
        const scope = channelScopeKey(ch.kind, ch.name, rcpt);
        const pid = (ch.kind === 'wecom' ? `wxuid:${rcpt}` : `${ch.kind}:${rcpt}`).slice(0, 64);
        const tid = await cfgStore.conversations.resolveThread(ch.route_key, scope, pid);
        await cfgStore.conversations.appendMessage({ thread_id: tid, direction: 'out', channel: source, principal_id: pid, job_id: jobId, content });
        return tid;
      }));
      threadId = tids[0];
    } catch (e) {
      await store.appendAudit({ ts, job_id: jobId, request_id: requestId, event: 'ledger_error', detail: { stage: 'outbound', error: String(e).slice(0, 200) } }).catch(() => undefined);
    }
  }

  const single = recipients.length === 1;
  const job: Job = {
    job_id: jobId, request_id: requestId,
    status: r.ok ? 'done' : 'error',
    target: 'channel-send', profile: deps.cfg.defaultProfile, project: '',
    source, client_app_id: client?.app_id, thread_id: threadId,
    input_preview: content.slice(0, 200), input: content,
    result: r.ok ? { text, channel: channelName, to: single ? recipients[0] : recipients, ...(card ? { card: true } : {}), ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) } : undefined,
    error: r.ok ? undefined : (r.error ?? '送达失败'),
    metadata: { outbound: true, via: 'send', channel: channelName, recipients: recipients.length, ...(single ? { recipient: recipients[0] } : {}), ...(card ? { card: card.type } : {}), ...(images.length ? { images: images.length } : {}), ...(files.length ? { files: files.length } : {}) },
    created_at: ts, updated_at: ts,
  };
  await store.createJob(job).catch(() => undefined);
  await store.appendAudit({
    ts, job_id: jobId, request_id: requestId,
    event: r.ok ? 'outbound_sent' : 'outbound_send_error',
    detail: { channel: channelName, to: single ? recipients[0] : `${recipients.length}人`, source, ...(card ? { card: card.type } : {}), ...(images.length ? { images: images.length } : {}), ...(files.length ? { files: files.length } : {}), ...(r.ok ? { thread_id: threadId ?? null } : { error: r.error }) },
  }).catch(() => undefined);
  if (client) void cfgStore.clients.touch(client.app_id).catch(() => undefined);

  if (r.ok) send(res, 200, { ok: true, job_id: jobId, request_id: requestId, thread_id: threadId ?? null, recipients: recipients.length });
  else send(res, 502, { ok: false, job_id: jobId, request_id: requestId, error: r.error ?? '送达失败' });
}
