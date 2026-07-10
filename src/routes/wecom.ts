// 企业微信入站（公开面）：自建应用「接收消息」回调 → 中枢当回调地址 → 走路由 → 被动加密回复 + 超窗 qyapi 主动推。
// 自带验签（无需 admin/接入方鉴权）；短窗口聚合(WECOM_COALESCE)把连发的图+文合成一轮；身份=解密报文 FromUserName。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readRawBody } from '../app/http';
import type { EngineRuntime } from '../app/engine';
import { UPLOAD_MIME, objectKey, putObject, storageBucketForRuntime } from '../adapters/storage/object-storage';
import { resolveTargetDef } from '../core/targets/resolve';
import { wecomBuildReply, wecomDecrypt, wecomSign, wecomVerifyUrl, wecomXmlField } from '../adapters/channels/wecom-crypto';
import { WECOM_TEXT_SAFE_BYTES, getWecomMedia, sendWecomText } from '../adapters/channels/wecom-api';
import { channelScopeKey } from '../app/channels';
import type { RuntimeActor, RuntimeContext, RuntimeSource } from '../core/edition';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { AppConfig } from '../core/config/config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

// ---- 企业微信入站（公开面）：自建应用「接收消息」回调 → 中枢当回调地址 → 走 llm 路由 → 被动加密回复 ----
// v1 只做被动回复（回复随回调 HTTP 响应返回，无需 qyapi/可信IP）；慢回答靠企微自身重试（同 MsgId 复用任务）兜一程。
// 后续增量：注册 wecom-notify 送达 + 中枢 qyapi 主动推，覆盖 >5s 的长回答与执行器大脑。身份纪律：企微解密报文里的 FromUserName 即可信操作主体。
const wecomSeen = new Map<string, { jobId: string; ts: number }>(); // MsgId 去重：企微 5s 无响应会重试同一条，首攻已接管则重试直接空 ack
function pruneWecomSeen(): void { const cut = Date.now() - 5 * 60_000; for (const [k, v] of wecomSeen) if (v.ts < cut) wecomSeen.delete(k); }

function wecomActor(accountId: string): RuntimeActor {
  return { kind: 'channel', id: `wecom:${accountId}`, roles: ['channel'], displayName: accountId };
}

export interface WecomApiDeps {
  cfg: AppConfig;
  isPaused: () => boolean;
  runtimeContextFor: (input: RuntimeContextInput) => Promise<RuntimeContext>;
  runtimeStoresFor: (ctx: RuntimeContext) => { state: RuntimeStateStore; config: ConfigStoreContract | null };
  resolveProjectPathFor: (config: ConfigStoreContract | null, name: string) => Promise<string | null>;
  now: () => string;
  engineForContext: (ctx: RuntimeContext) => Pick<EngineRuntime, 'launchJob' | 'waitForJob'>;
}

interface RuntimeContextInput {
  source: RuntimeSource;
  requestId: string;
  actor?: RuntimeActor;
}

async function wecomRuntime(deps: WecomApiDeps, accountId: string, requestId: string) {
  const ctx = await deps.runtimeContextFor({ source: 'channel', requestId, actor: wecomActor(accountId) });
  return { ctx, ...deps.runtimeStoresFor(ctx) };
}

// 异步主动推（送达超出 5s 被动窗口的慢回答）：任务完成后中枢经 qyapi 把回复推回企微用户。
// 与被动回复互斥——被动只在"首攻 done"分支发，主动推只在"首攻超窗"分支排；企微重试一律空 ack，绝不重复发。
// 凭证由触发那条消息当场解析好传入（corpid 来自密文 receiveId），不依赖持久化。
function scheduleWecomPush(deps: WecomApiDeps, accountId: string, corpid: string, secret: string, agentid: string, touser: string, jobId: string): void {
  void (async () => {
    const { ctx, state: store } = await wecomRuntime(deps, accountId, jobId);
    const engine = deps.engineForContext(ctx);
    const j = await engine.waitForJob(jobId, 110_000);
    if (!j || j.status !== 'done') return; // 失败不推人渠道（与送达策略一致）
    if (!secret || !corpid || !agentid) {
      await store.appendAudit({ ts: deps.now(), job_id: jobId, request_id: j.request_id, event: 'wecom_push_skipped', detail: { reason: '缺 secret/corpid/agentid，无法主动推（快答仍走被动回复）' } }).catch(() => { /* 审计失败不影响 */ });
      return;
    }
    const r = (j.result ?? {}) as Record<string, unknown>;
    const text = typeof r['text'] === 'string' && r['text'] ? (r['text'] as string) : (j.raw_result || '');
    if (!text) return;
    try {
      const res = await sendWecomText(corpid, secret, agentid, touser, String(text));
      await store.appendAudit({ ts: deps.now(), job_id: jobId, request_id: j.request_id, event: res.ok ? 'wecom_push' : 'wecom_push_error', detail: { to: touser, errcode: res.errcode, errmsg: res.errmsg } }).catch(() => { /* 审计失败不影响 */ });
    } catch (e) {
      await store.appendAudit({ ts: deps.now(), job_id: jobId, request_id: j.request_id, event: 'wecom_push_error', detail: { to: touser, error: String(e).slice(0, 200) } }).catch(() => { /* 审计失败不影响 */ });
    }
  })();
}

// ---- 入站消息短窗口聚合 ----
// 企微把「图片+文字」永远拆成多条几乎同时到达的消息（无法合并发）。中枢按 (账号+用户) 攒一个小窗口，
// 把这一连串合成「一轮」再喂大脑（图+问题一起），否则文字那条会先于图单独跑、答「没收到图」。
// 首条 hold 住回调用于被动快回复（零依赖、不要求配 agentid/secret）；后续条立即空 ack；
// 合并轮答得慢（含图基本都慢）则空 ack + 异步主动推。窗口 < 企微 5s，留出大脑时间。
type WecomPart = { kind: 'text'; text: string } | { kind: 'image'; mediaId: string; picUrl: string };
interface WecomBuf {
  parts: WecomPart[]; msgIds: string[]; timer: ReturnType<typeof setTimeout> | null; firstMs: number;
  held: { res: ServerResponse; token: string; aesKey: string; corpid: string; fromUser: string } | null;
  accountId: string; routeKey: string; secret: string; agentId: string; corpid: string; fromUser: string;
  cc: Record<string, unknown>; replyWaitMs: number; publicBaseUrl: string;
  deps: WecomApiDeps;
}
const wecomBuf = new Map<string, WecomBuf>();
const WECOM_COALESCE_MS = 1500;     // 攒消息窗口：同一用户这段时间内连发的合成一轮
const WECOM_COALESCE_MAX_MS = 3000; // 窗口上限：连发不断也不无限等，到顶就发（给大脑留时间）
// 企微聊天窗不渲染 Markdown：默认给大脑注入"纯文本、无 emoji"输出风格（随任务 metadata.reply_hint 透传，llm 适配器据此追加进系统提示）。
// 渠道配置里显式设 reply_hint 可覆盖文案、设为空串可关闭；网页嵌入聊天组件等能渲染 md 的入口不走这条路径、行为不变。
const WECOM_PLAINTEXT_HINT = '【输出格式·企业微信】你的回复会发送到企业微信聊天窗口，它不渲染 Markdown：请用纯文本回答，不要使用任何 Markdown 语法——不要用 #/## 标题、* 或 ** 加粗、`代码`/```代码块```、| 表格、- 或 * 列表符号、> 引用。需要分条时用「1. 2. 3.」加换行；需要呈现表格类信息时改用「字段：值」逐行罗列。也不要使用 emoji 表情符号。用简洁的文字和换行组织内容，确保在纯文本里清晰易读。';

function publicBaseUrl(req: IncomingMessage): string {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0]!.trim();
  const protoHeader = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim();
  const proto = protoHeader || (/^(localhost|127\.|0\.0\.0\.0)/.test(host) ? 'http' : 'https');
  return `${proto}://${host || 'localhost'}`;
}

/** 窗口结束：把缓冲里的多条消息合成一轮 → 下载/落桶图片 → 起一个任务 → 首条回调被动回复 or 异步推。永不抛。 */
async function flushWecom(key: string): Promise<void> {
  const buf = wecomBuf.get(key);
  if (!buf) return;
  wecomBuf.delete(key);
  if (buf.timer) clearTimeout(buf.timer);
  let auditStore: RuntimeStateStore | null = null;
  const held = buf.held;
  const replyHeld = (text: string): void => {
    if (!held) return;
    try { held.res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' }); held.res.end(wecomBuildReply(held.token, held.aesKey, held.corpid, held.fromUser, text)); } catch { /* res 可能已关 */ }
  };
  const ackHeld = (): void => { if (!held) return; try { held.res.writeHead(200, { 'content-type': 'text/plain' }); held.res.end(''); } catch { /* ignore */ } };
  try {
    const { ctx, state: store, config: cfgStore } = await wecomRuntime(buf.deps, buf.accountId, buf.msgIds[0] ?? `wecom:${key}`);
    const engine = buf.deps.engineForContext(ctx);
    auditStore = store;
    if (!cfgStore) { ackHeld(); return; }
    // 合成正文：文字原样，图片在此统一下载落桶取永久 URL（失败回退企微临时 PicUrl）→ markdown 图
    const segments: string[] = [];
    let hasImage = false, hasText = false;
    const bucketName = String(buf.cc['bucket'] ?? '').trim();
    const configuredBucket = bucketName ? await cfgStore.storageBuckets.get(bucketName).catch(() => null) : null;
    const bucket = storageBucketForRuntime(configuredBucket, buf.publicBaseUrl);
    for (const part of buf.parts) {
      if (part.kind === 'text') { if (part.text) { segments.push(part.text); hasText = true; } continue; }
      hasImage = true;
      let imgUrl = '';
      if (part.mediaId && bucket.enabled && buf.corpid && buf.secret) {
        const media = await getWecomMedia(buf.corpid, buf.secret, part.mediaId);
        if (media.ok && media.buf) {
          try {
            const mime = UPLOAD_MIME.test(media.mime ?? '') ? media.mime! : 'image/jpeg';
            const okey = objectKey(bucket, `wecom_${buf.accountId}`, mime);
            imgUrl = await putObject(bucket, okey, media.buf, mime, { root: buf.deps.cfg.root });
            await store.appendAudit({ ts: buf.deps.now(), job_id: '-', request_id: buf.msgIds[0] ?? '-', event: 'wecom_image_rehosted', detail: { account: buf.accountId, bucket: bucket.name, storage: bucket.kind, key: okey, bytes: media.buf.length, mime } }).catch(() => undefined);
          } catch (e) { await store.appendAudit({ ts: buf.deps.now(), job_id: '-', request_id: buf.msgIds[0] ?? '-', event: 'wecom_image_rehost_failed', detail: { account: buf.accountId, error: String(e).slice(0, 300) } }).catch(() => undefined); }
        } else { await store.appendAudit({ ts: buf.deps.now(), job_id: '-', request_id: buf.msgIds[0] ?? '-', event: 'wecom_image_rehost_failed', detail: { account: buf.accountId, error: media.error ?? 'media/get 失败' } }).catch(() => undefined); }
      }
      if (!imgUrl) imgUrl = part.picUrl;
      if (imgUrl) segments.push(`![](${imgUrl})`);
    }
    if (hasImage && !hasText && !segments.some((s) => s.startsWith('!['))) { replyHeld('图片没收到（拿不到图片地址），请重发或改用文字描述。'); return; }
    let fullInput = segments.join('\n').trim();
    if (!fullInput) { ackHeld(); return; }
    if (hasImage && !hasText) fullInput += '\n[用户发来一张图片]'; // 纯图无文字：给大脑一句中性引导

    const route = await cfgStore.routes.get(buf.routeKey);
    const targetDef = route ? await resolveTargetDef(cfgStore, route.target) : null;
    if (!route || !route.enabled || !targetDef || targetDef.enabled === false) { replyHeld('该渠道尚未配置好（路由缺失或未启用），请联系管理员。'); return; }
    const projectPath = route.project ? await buf.deps.resolveProjectPathFor(cfgStore, route.project) : null;
    const scopeKey = channelScopeKey('wecom', buf.accountId, buf.fromUser); // 出站 /send 复用同一函数，杜绝 scope 漂移
    const sess = await cfgStore.conversations.sessionForScope(route.route_key, scopeKey);
    // 渠道输出风格：默认注入企微纯文本提示；渠道配置 reply_hint 可覆盖文案，显式空串则关闭。
    const replyHint = (buf.cc['reply_hint'] !== undefined ? String(buf.cc['reply_hint']) : WECOM_PLAINTEXT_HINT).trim();
    const job = await engine.launchJob({
      requestId: `wecom_${randomUUID()}`, fullInput,
      route, routeKey: route.route_key, target: route.target, project: route.project ?? null, projectPath,
      profileName: route.profile, permission: route.permission, source: `wecom:${buf.accountId}`,
      metadata: { wecom_account: buf.accountId, wecom_userid: buf.fromUser, wecom_msgtype: hasImage ? (hasText ? 'image+text' : 'image') : 'text', wecom_msg_count: buf.parts.length, ...(buf.agentId ? { wecom_agentid: buf.agentId } : {}), wecom_msgid: buf.msgIds.join(','), no_delivery: true, ...(replyHint ? { reply_hint: replyHint } : {}) },
      session: { sessionId: sess.sessionId, isContinue: sess.isContinue },
      threadScope: scopeKey, principalId: `wxuid:${buf.fromUser}`.slice(0, 64), channel: `wecom:${buf.accountId}`,
    });
    for (const mid of buf.msgIds) wecomSeen.set(mid, { jobId: job.job_id, ts: Date.now() });
    // 5s 窗口余额：用掉了 攒窗口+图片下载 的时间，剩下的给大脑；够则被动回复，不够则空 ack + 异步推
    const budget = Math.max(300, Math.min(buf.replyWaitMs, 4500) - (Date.now() - buf.firstMs));
    const fin = await engine.waitForJob(job.job_id, budget);
    if (fin && fin.status === 'done') {
      const r = (fin.result ?? {}) as Record<string, unknown>;
      const text = typeof r['text'] === 'string' && r['text'] ? (r['text'] as string) : (fin.raw_result || '（无内容）');
      // 被动回复（单条 XML）无法分条：超企微字节上限会被客户端截断。长回复改走异步主动推（sendWecomText 会按字节分条发全）。
      // 需出站凭证；缺凭证时只能退回被动回复（截断，但已是无凭证下最优）。
      if (Buffer.byteLength(String(text), 'utf8') > WECOM_TEXT_SAFE_BYTES && buf.corpid && buf.secret && buf.agentId) {
        ackHeld();
        scheduleWecomPush(buf.deps, buf.accountId, buf.corpid, buf.secret, buf.agentId, buf.fromUser, job.job_id);
        return;
      }
      replyHeld(String(text)); return;
    }
    if (fin && (fin.status === 'error' || fin.status === 'rejected')) { replyHeld('抱歉，本次处理失败，请稍后再试。'); return; }
    ackHeld();
    scheduleWecomPush(buf.deps, buf.accountId, buf.corpid, buf.secret, buf.agentId, buf.fromUser, job.job_id);
  } catch (e) {
    ackHeld();
    await auditStore?.appendAudit({ ts: buf.deps.now(), job_id: '-', request_id: buf.msgIds[0] ?? '-', event: 'wecom_flush_error', detail: { account: buf.accountId, error: String(e).slice(0, 300) } }).catch(() => undefined);
  }
}

export async function handleWecomInboundFor(deps: WecomApiDeps, req: IncomingMessage, res: ServerResponse, accountId: string, url: URL): Promise<void> {
  const { config: cfgStore } = await wecomRuntime(deps, accountId, `wecom:${accountId}:${url.searchParams.get('timestamp') ?? Date.now()}`);
  if (!cfgStore) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('service not ready'); return; }
  // 渠道配置来自后台「渠道」注册表（bz_channels），不再写死 config.json
  const channel = await cfgStore.channels.get(accountId);
  if (!channel || !channel.enabled || channel.kind !== 'wecom') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('unknown wecom channel'); return; }
  const cc = channel.config as Record<string, unknown>;
  const token = String(cc['token'] ?? '');
  const aesKey = String(cc['aes_key'] ?? '');
  const cfgCorpid = String(cc['corpid'] ?? '').trim();
  const secret = String(cc['secret'] ?? '').trim();
  const cfgAgentId = String(cc['agentid'] ?? '').trim();
  const replyWaitMs = Number(cc['reply_wait_ms'] ?? 4000) || 4000;
  if (!token || !aesKey) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('channel not configured'); return; }
  const sig = url.searchParams.get('msg_signature') ?? '';
  const ts = url.searchParams.get('timestamp') ?? '';
  const nonce = url.searchParams.get('nonce') ?? '';

  // GET：企微后台「保存」时的 URL 验证（解密 echostr 原样回显）
  if (req.method === 'GET') {
    const plain = wecomVerifyUrl(token, aesKey, sig, ts, nonce, url.searchParams.get('echostr') ?? '', cfgCorpid || undefined);
    if (plain == null) { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('invalid signature'); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(plain); return;
  }

  // POST：加密消息
  let xml = '';
  try { xml = await readRawBody(req); } catch { res.writeHead(413, { 'content-type': 'text/plain' }); res.end(''); return; }
  const encrypt = wecomXmlField(xml, 'Encrypt');
  if (!encrypt || wecomSign(token, ts, nonce, encrypt) !== sig) { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('invalid signature'); return; }
  let inner: { message: string; receiveId: string };
  try { inner = wecomDecrypt(aesKey, encrypt); } catch { res.writeHead(400, { 'content-type': 'text/plain' }); res.end(''); return; }
  if (cfgCorpid && inner.receiveId && inner.receiveId !== cfgCorpid) { res.writeHead(401, { 'content-type': 'text/plain' }); res.end(''); return; }

  const msg = inner.message;
  const fromUser = wecomXmlField(msg, 'FromUserName');
  const msgType = wecomXmlField(msg, 'MsgType');
  const msgId = wecomXmlField(msg, 'MsgId') || `${fromUser}:${wecomXmlField(msg, 'CreateTime')}`;
  const agentId = cfgAgentId || wecomXmlField(msg, 'AgentID');
  // corpid：优先配置，缺省取密文尾部 receiveId（企微自建应用即 corpid）；被动回复 receiveid 与主动推 gettoken 都用它
  const corpid = (cfgCorpid || inner.receiveId || '').trim();
  const replyText = (text: string): void => { res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' }); res.end(wecomBuildReply(token, aesKey, corpid, fromUser, text)); };
  const ackEmpty = (): void => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(''); };

  if (msgType === 'event') { ackEmpty(); return; }                          // 关注/进入应用等事件：静默 ack
  if (deps.isPaused()) { replyText('服务暂停中，请稍后再试。'); return; }

  // 企微 5s 无响应会重试同一 MsgId：占位去重（提前到入缓冲前，避免重试重复并入/重复处理）
  pruneWecomSeen();
  if (wecomSeen.has(msgId)) { ackEmpty(); return; }
  wecomSeen.set(msgId, { jobId: '', ts: Date.now() });

  // 解析这条消息为一个 part；图片此刻只记 MediaId/PicUrl，下载落桶推迟到窗口结束统一做（见 flushWecom）
  let part: WecomPart;
  if (msgType === 'text') {
    const text = wecomXmlField(msg, 'Content').trim();
    if (!text) { ackEmpty(); return; }
    part = { kind: 'text', text };
  } else if (msgType === 'image') {
    part = { kind: 'image', mediaId: wecomXmlField(msg, 'MediaId').trim(), picUrl: wecomXmlField(msg, 'PicUrl').trim() };
  } else {
    replyText('我目前只看得懂文字和图片消息哦，请用文字或图片描述你的问题。'); return;
  }

  // 短窗口聚合：同一 (账号+用户) 的连发合成一轮。首条 hold 住回调（被动回复），后续条立即空 ack。
  const key = `${accountId}:${fromUser}`;
  const coalesceMs = Math.min(Math.max(Number(cc['coalesce_ms'] ?? WECOM_COALESCE_MS) || WECOM_COALESCE_MS, 0), WECOM_COALESCE_MAX_MS);
  const existing = wecomBuf.get(key);
  if (existing) {
    existing.parts.push(part); existing.msgIds.push(msgId);
    if (existing.timer) clearTimeout(existing.timer);
    const wait = Math.max(0, Math.min(coalesceMs, WECOM_COALESCE_MAX_MS - (Date.now() - existing.firstMs)));
    existing.timer = setTimeout(() => { void flushWecom(key); }, wait);
    ackEmpty(); return;                       // 后续条：正文已并入缓冲，立即空 ack
  }
  const buf: WecomBuf = {
    parts: [part], msgIds: [msgId], timer: null, firstMs: Date.now(),
    held: { res, token, aesKey, corpid, fromUser },   // 首条 hold 住 res，窗口结束由 flushWecom 统一回复
    accountId, routeKey: channel.route_key, secret, agentId, corpid, fromUser, cc, replyWaitMs, publicBaseUrl: publicBaseUrl(req),
    deps,
  };
  buf.timer = setTimeout(() => { void flushWecom(key); }, coalesceMs);
  wecomBuf.set(key, buf);
  // 首条不立即响应：res 已交给 buf.held，连接保持到 flushWecom 写回
}
