// 聊天入口（公开面）：网页组件 → POST /chat/:entry → 同一条路由/总账/知识/工具链路。
// entry_key 可公开；防滥用 = Origin 白名单 + 按 IP 限速 + 可停用。访客=匿名主体；签名访客票据(verifyVisitorTicket)验签后写 metadata.visitor_uid。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ipOf, readBody, readBodyCapped, send } from '../app/http';
import type { EngineRuntime } from '../app/engine';
import { resolveTargetDef } from '../core/targets/resolve';
import { extractAttachments } from '../core/platform/content';
import { AUDIO_UPLOAD_MIME, FILE_UPLOAD_MAX_BYTES, FILE_UPLOAD_MIME, UPLOAD_MIME, objectKey, putObject, storageBucketForRuntime } from '../adapters/storage/object-storage';
import { type PageRule, resolvePage } from '../core/platform/pagecontext';
import type { ChatEntry, Job } from '../core/contracts/types';
import { namedRateLimitedFor } from '../app/auth';
import type { AppConfig } from '../core/config/config';
import type { RuntimeActor, RuntimeContext, RuntimeSource } from '../core/edition';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

// ---- 聊天入口（公开面）：网页组件 → POST /chat/:entry → 同一条路由/总账/知识/工具链路 ----
// entry_key 设计为可公开（页面源码可见）；防滥用 = Origin 白名单 + 按 IP 限速 + 可停用/删除。
// 落点是「触发路由」：背后是 llm 还是执行器智能体，入口无感（用户铁律：聊天不绑死 LLM）。
// 身份纪律（总纲）：网页访客=匿名主体。metadata 由服务端构造，组件只能带 visitor_id（会话连续性用），
// 业务操作主体（subject_field → on-behalf-of）永远为空——挂工具的路由读公开数据可用，写操作业务侧自然拒。

export function chatCors(res: ServerResponse): void {
  // 公开面不用 Cookie，CORS 直接放开；"哪些站点能嵌"由服务端 Origin 白名单裁决（不匹配 403，浏览器 Origin 不可伪造）
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

function publicBaseUrl(req: IncomingMessage): string {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0]!.trim();
  const protoHeader = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim();
  const proto = protoHeader || (/^(localhost|127\.|0\.0\.0\.0)/.test(host) ? 'http' : 'https');
  return `${proto}://${host || 'localhost'}`;
}

function inferUploadMime(filename: string, mime: string): string {
  const m = mime.toLowerCase().trim();
  if (m) return m;
  const ext = filename.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    txt: 'text/plain', log: 'text/x-log', ini: 'text/x-ini', conf: 'text/x-conf', md: 'text/markdown', markdown: 'text/markdown',
    csv: 'text/csv', tsv: 'text/tab-separated-values', sql: 'application/sql',
    json: 'application/json', jsonl: 'application/x-ndjson', xml: 'application/xml', html: 'text/html', htm: 'text/html',
    yaml: 'application/yaml', yml: 'application/yaml',
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip', rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
  };
  return map[ext] ?? '';
}

export interface ChatApiDeps {
  cfg: AppConfig;
  isPaused: () => boolean;
  runtimeContextFor: (input: RuntimeContextInput) => Promise<RuntimeContext>;
  runtimeStoresFor: (ctx: RuntimeContext) => { state: RuntimeStateStore; config: ConfigStoreContract | null };
  resolveProjectPathFor: (config: ConfigStoreContract | null, name: string) => Promise<string | null>;
  now: () => string;
  engineForContext: (ctx: RuntimeContext) => Pick<EngineRuntime, 'launchJob'>;
}

interface RuntimeContextInput {
  source: RuntimeSource;
  requestId: string;
  actor?: RuntimeActor;
}

function chatOriginAllowed(entry: ChatEntry, req: IncomingMessage): boolean {
  if (!entry.allowed_origins.length) return true; // 未配=不限，控制台建议上线前配白名单
  const o = (req.headers['origin'] ?? '').toString().replace(/\/+$/, '');
  if (!o) return true; // 无 Origin = 非浏览器调用（curl 等），白名单管不到也不必管——它防的是别家网页盗嵌
  return entry.allowed_origins.some((a) => a.replace(/\/+$/, '') === o);
}

async function chatRateLimited(config: ConfigStoreContract | null, entry: ChatEntry, ip: string): Promise<boolean> {
  const limit = entry.rate_limit_per_min || 20;
  return await namedRateLimitedFor(config, `chat:${entry.entry_key}:${ip}`, limit, 60);
}

async function chatRuntime(deps: ChatApiDeps, requestId: string, actorId = 'visitor') {
  const ctx = await deps.runtimeContextFor({
    source: 'chat',
    requestId,
    actor: { kind: 'visitor', id: actorId || 'visitor', roles: ['visitor'] },
  });
  return { ctx, ...deps.runtimeStoresFor(ctx) };
}


/** job → 聊天响应形态。错误不暴露内部细节（公开面）。references=知识检索命中（doc_id 留在中枢侧，不外露）。 */
function chatShape(job: Job, visitorId: string): Record<string, unknown> {
  if (job.status === 'done') {
    const r = (job.result ?? {}) as Record<string, unknown>;
    const reply = typeof r['text'] === 'string' && r['text'] ? (r['text'] as string)
      : r['report'] ? JSON.stringify(r['report']) : (job.raw_result ?? '（无内容）');
    const refs = job.dispatch?.kb_refs;
    const attachments = extractAttachments(reply);
    return {
      done: true, job_id: job.job_id, visitor_id: visitorId, reply,
      ...(attachments.length ? { attachments } : {}),
      ...(refs?.length ? { references: refs.map((x) => ({ seq: x.seq, title: x.title, score: x.score, snippet: x.snippet })) } : {}),
    };
  }
  if (job.status === 'error' || job.status === 'rejected') {
    return { done: true, error: true, job_id: job.job_id, visitor_id: visitorId, reply: '抱歉，本次处理失败，请稍后再试。' };
  }
  return { done: false, job_id: job.job_id, visitor_id: visitorId };
}


export async function handleChatFor(deps: ChatApiDeps, req: IncomingMessage, res: ServerResponse, entryKey: string): Promise<void> {
  const { ctx, config: cfgStore } = await chatRuntime(deps, `chat:${entryKey}`);
  if (!cfgStore) { send(res, 400, { error: '聊天入口需要 mysql 后端' }); return; }
  const engine = deps.engineForContext(ctx);
  const entry = await cfgStore.chatEntries.get(entryKey);
  if (!entry || !entry.enabled) { send(res, 404, { error: '聊天入口不存在或已停用' }); return; }
  if (!chatOriginAllowed(entry, req)) { send(res, 403, { error: '该站点未被允许嵌入此聊天入口' }); return; }
  if (deps.isPaused()) { send(res, 503, { done: true, error: true, reply: '服务暂停中，请稍后再试。' }); return; }
  if (await chatRateLimited(cfgStore, entry, ipOf(req))) { send(res, 429, { done: true, error: true, reply: '提问太频繁了，请稍候片刻再试。' }); return; }

  const body = (await readBody(req).catch(() => ({} as Record<string, unknown>)));
  const message = String(body['message'] ?? '').trim().slice(0, 4000);
  if (!message) { send(res, 400, { error: 'message 必填' }); return; }
  // visitor_id：组件生成存 localStorage，只用于会话连续性，不是身份凭证；不合规直接服务端换发
  let visitor = String(body['visitor_id'] ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (visitor.length < 8) visitor = randomUUID().replace(/-/g, '').slice(0, 16);

  // 签名访客票据（可选）：业务后端用自己的接入方 token 给登录用户签短票 → 可信身份进 metadata.visitor_uid。
  // 无票=匿名照常（混合模式：登录用户带票、游客不带）；票坏/过期=明确 401（静默降级会掩盖业务侧集成 bug）。
  let visitorUid = '';
  const ticket = String(body['ticket'] ?? '');
  if (ticket) {
    if (!entry.ticket_client) { send(res, 401, { error: '该入口未启用身份票据' }); return; }
    const tc = await cfgStore.clients.get(entry.ticket_client);
    if (!tc || !tc.enabled) { send(res, 503, { done: true, error: true, reply: '该入口尚未就绪（票据签发方不可用），请联系站点管理员。' }); return; }
    const v = verifyVisitorTicket(ticket, tc.token);
    if (!v) { send(res, 401, { error: '身份票据无效或已过期，请刷新页面重新登录' }); return; }
    visitorUid = v.uid;
    // 票据验签 = 该接入方的凭证被实际使用——更新最近调用，让"作为聊天入口票据签发方"的接入方也显示活跃（否则它天天在用却显示从未）
    void cfgStore.clients.touch(tc.app_id).catch(() => { /* 观测字段，失败不影响主流程 */ });
  }

  const route = await cfgStore.routes.get(entry.route_key);
  const targetDef = route ? await resolveTargetDef(cfgStore, route.target) : null;
  if (!route || !route.enabled || !targetDef || targetDef.enabled === false) {
    send(res, 503, { done: true, error: true, reply: '该入口尚未就绪（路由或目标未配置），请联系站点管理员。' }); return;
  }
  const projectPath = route.project ? await deps.resolveProjectPathFor(cfgStore, route.project) : null;
  if (targetDef.needs_project && !projectPath) {
    send(res, 503, { done: true, error: true, reply: '该入口尚未就绪（项目未登记），请联系站点管理员。' }); return;
  }

  // 聊天入口天然按访客续会话/续线索（入口语义优先于路由会话策略）。
  // 带票用户按 uid 续：同一个人换设备/清缓存也接得上；匿名按 visitor_id（localStorage 随机串）。
  // 可选 thread_id：同一身份下按它切分平行线程（业务多会话 UI 映射）——开新会话=换 thread_id，继续当前会话=复用。
  // 它只是已验身份内部的分区键，不跨权限边界；清洗限长防滥用。会话与对话总账同键切分，连续性一致。
  const thread = String(body['thread_id'] ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  const scopeKey = chatScopeKey(entry.entry_key, visitor, visitorUid, thread);
  const sess = await cfgStore.conversations.sessionForScope(route.route_key, scopeKey);
  // 页面上下文（寻址）：组件抓的 url/title(+可选 page_key) → 按本入口登记表模式匹配 → 解析出页面说明。
  // 落 metadata.page_context（控制台任务详情可见，精准定位"用户从哪个页面来"）；launchJob 据此注入【当前页面】给 AI。
  // 是用户侧可伪造的线索：只作理解/检索提示，绝不用于鉴权或工具放行。
  let pageContext: Record<string, unknown> | undefined;
  const ctxIn = body['context'];
  if (ctxIn && typeof ctxIn === 'object') {
    const c = ctxIn as Record<string, unknown>;
    const rules = await cfgStore.chatEntries.listPageContexts(entry.entry_key).catch(() => [] as PageRule[]);
    const resolved = resolvePage(rules, { url: c['url'], title: c['title'], page_key: c['page_key'], page_name: c['page_name'] });
    if (resolved.url || resolved.page_key || resolved.page_name) pageContext = resolved as unknown as Record<string, unknown>;
  }
  const job = await engine.launchJob({
    requestId: `chat_${randomUUID()}`, fullInput: message,
    route, routeKey: route.route_key,
    target: route.target, project: route.project ?? null, projectPath,
    profileName: route.profile, permission: route.permission, source: `chat:${entry.entry_key}`,
    // 服务端构造：visitor_uid 只可能来自验签通过的票据，组件/访客无法伪造（鉴权总纲）
    metadata: { chat_entry: entry.entry_key, visitor_id: visitor, no_delivery: true, ...(visitorUid ? { visitor_uid: visitorUid } : {}), ...(thread ? { thread_id: thread } : {}), ...(pageContext ? { page_context: pageContext } : {}) },
    session: { sessionId: sess.sessionId, isContinue: sess.isContinue },
    threadScope: scopeKey, principalId: (visitorUid ? `uid:${visitorUid}` : `visitor:${visitor}`).slice(0, 64), channel: `chat:${entry.entry_key}`,
  });

  // 聊天主链路：创建任务后立即返回 job_id，回答统一由 SSE 事件流输出。
  send(res, 200, chatShape(job, visitor));
}

function writeSse(res: ServerResponse, event: string, data: Record<string, unknown>): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * 聊天入口 SSE 结果流：widget 主链路。
 * 当前阶段输出 job 状态与最终 answer；后续 token 级模型流、工具调用阶段、审批状态都挂同一条 wire 面继续加事件。
 */
export async function handleChatEventsFor(deps: ChatApiDeps, req: IncomingMessage, res: ServerResponse, entryKey: string, jobId: string, url: URL): Promise<void> {
  const { ctx, state: store, config: cfgStore } = await chatRuntime(deps, `chat_events:${entryKey}`);
  if (!cfgStore) { send(res, 400, { error: '聊天入口需要 mysql 后端' }); return; }
  const entry = await cfgStore.chatEntries.get(entryKey);
  if (!entry || !entry.enabled) { send(res, 404, { error: '聊天入口不存在或已停用' }); return; }
  if (!chatOriginAllowed(entry, req)) { send(res, 403, { error: '该站点未被允许嵌入此聊天入口' }); return; }
  if (deps.isPaused()) { send(res, 503, { done: true, error: true, reply: '服务暂停中，请稍后再试。' }); return; }

  const first = await store.getJob(jobId);
  if (!first || (first.metadata ?? {})['chat_entry'] !== entryKey) { send(res, 404, { error: 'not found' }); return; }

  // ctx 目前用于保证扩展发行版在同一上下文下取 store；保留变量避免未来事件需要 engine/context 时重新改签名。
  void ctx;
  const maxMs = Math.min(Math.max(Number(url.searchParams.get('max_wait') ?? 5 * 60 * 1000) || 0, 1000), 5 * 60 * 1000);
  const deadline = Date.now() + maxMs;
  let closed = false;
  let lastStatus = '';
  let lastPing = 0;
  req.on('close', () => { closed = true; });
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();
  writeSse(res, 'open', { ok: true, job_id: jobId, status: first.status });

  while (!closed && Date.now() < deadline) {
    const job = await store.getJob(jobId);
    if (!job || (job.metadata ?? {})['chat_entry'] !== entryKey) {
      writeSse(res, 'failed', { done: true, error: true, job_id: jobId, reply: '任务不存在或已过期。' });
      res.end();
      return;
    }
    if (job.status !== lastStatus) {
      lastStatus = job.status;
      writeSse(res, 'status', { job_id: jobId, status: job.status });
    }
    if (job.status !== 'queued' && job.status !== 'running' && job.status !== 'dispatched') {
      writeSse(res, 'done', chatShape(job, String((job.metadata ?? {})['visitor_id'] ?? '')));
      res.end();
      return;
    }
    if (Date.now() - lastPing > 10_000) {
      lastPing = Date.now();
      writeSse(res, 'ping', { ts: deps.now(), job_id: jobId });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!closed) {
    writeSse(res, 'timeout', { done: false, job_id: jobId });
    res.end();
  }
}

/** 聊天入口/总账的线索 scope 键：handleChat 与拉历史共用同一公式，杜绝两处漂移导致拉到错的（空）线索。 */
function chatScopeKey(entryKey: string, visitor: string, visitorUid: string, thread: string): string {
  return ((visitorUid ? `chat:${entryKey}:uid:${visitorUid}` : `chat:${entryKey}:${visitor}`) + (thread ? `:t:${thread}` : '')).slice(0, 191);
}

/**
 * 聊天入口拉服务端会话历史（公开面，GET）：用于断线恢复、跨设备打开、异步完成结果回灌。
 * 重建与 handleChat 完全一致的 scopeKey → 只读 findThread（不创建）→ 返回正序总账。组件重开时回灌即显示。
 * 身份纪律：带票按 uid 线索、无票按 visitor 线索；票坏=401（与 handleChat 同，组件可据此提示重登）。
 */
export async function handleChatThreadFor(deps: ChatApiDeps, req: IncomingMessage, res: ServerResponse, entryKey: string, url: URL): Promise<void> {
  const { config: cfgStore } = await chatRuntime(deps, `chat_thread:${entryKey}`);
  if (!cfgStore) { send(res, 400, { error: '聊天入口需要 mysql 后端' }); return; }
  const entry = await cfgStore.chatEntries.get(entryKey);
  if (!entry || !entry.enabled) { send(res, 404, { error: '聊天入口不存在或已停用' }); return; }
  if (!chatOriginAllowed(entry, req)) { send(res, 403, { error: '该站点未被允许嵌入此聊天入口' }); return; }

  const visitor = String(url.searchParams.get('visitor_id') ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const thread = String(url.searchParams.get('thread_id') ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  let visitorUid = '';
  const ticket = String(url.searchParams.get('ticket') ?? '');
  if (ticket) {
    if (!entry.ticket_client) { send(res, 401, { error: '该入口未启用身份票据' }); return; }
    const tc = await cfgStore.clients.get(entry.ticket_client);
    if (!tc || !tc.enabled) { send(res, 200, { visitor_id: visitor, messages: [] }); return; } // 签发方暂不可用：当无历史，不阻断
    const v = verifyVisitorTicket(ticket, tc.token);
    if (!v) { send(res, 401, { error: '身份票据无效或已过期，请刷新页面重新登录' }); return; }
    visitorUid = v.uid;
  }
  if (!visitorUid && visitor.length < 8) { send(res, 200, { visitor_id: visitor, messages: [] }); return; } // 无可定位身份：空历史

  const scopeKey = chatScopeKey(entry.entry_key, visitor, visitorUid, thread);
  const threadId = await cfgStore.conversations.findThread(entry.route_key, scopeKey);
  if (!threadId) { send(res, 200, { visitor_id: visitor, messages: [] }); return; }
  const rows = await cfgStore.conversations.threadMessages(threadId, 50);
  // 出站消息现算富内容（图片/文件附件），与实时 chatShape 渲染口径一致；入站只回文本
  const messages = rows.map((m) => {
    const atts = extractAttachments(m.content); // 入站也解析：用户上传的图片以 ![](url) 进消息，回灌后同样渲染成缩略图
    if (m.direction === 'in') return { r: 'u', t: m.content, j: m.job_id, ts: m.created_at, ...(atts.length ? { atts } : {}) };
    return { r: 'a', t: m.content, j: m.job_id, ts: m.created_at, ...(atts.length ? { atts } : {}) };
  });
  send(res, 200, { visitor_id: visitor, messages });
}


/**
 * 聊天入口媒体上传：组件传图/语音 → 未配存储时落本机 data/uploads，配了 COS 等对象存储则落桶 → 返回永久公开 URL。
 * URL 永久不清理——支撑①完整聊天追溯（媒体不随会话清掉）②多模态大脑随时读/听 ③业务图片入参直接用。
 * 门禁与 /chat/:entry 同（Origin 白名单+IP 限速+可停用）。
 */
export async function handleChatUploadFor(deps: ChatApiDeps, req: IncomingMessage, res: ServerResponse, entryKey: string): Promise<void> {
  const { state: store, config: cfgStore } = await chatRuntime(deps, `chat_upload:${entryKey}`);
  if (!cfgStore) { send(res, 400, { error: '聊天入口需要 mysql 后端' }); return; }
  const entry = await cfgStore.chatEntries.get(entryKey);
  if (!entry || !entry.enabled) { send(res, 404, { error: '聊天入口不存在或已停用' }); return; }
  if (!chatOriginAllowed(entry, req)) { send(res, 403, { error: '该站点未被允许嵌入此聊天入口' }); return; }
  if (deps.isPaused()) { send(res, 503, { error: '服务暂停中，请稍后再试。' }); return; }
  if (await chatRateLimited(cfgStore, entry, ipOf(req))) { send(res, 429, { error: '操作太频繁，请稍后再试' }); return; }
  const configuredBucket = entry.bucket ? await cfgStore.storageBuckets.get(entry.bucket).catch(() => null) : null;
  const bucket = storageBucketForRuntime(configuredBucket, publicBaseUrl(req));

  let body: Record<string, unknown>;
  try { body = await readBodyCapped(req, FILE_UPLOAD_MAX_BYTES); }
  catch { send(res, 413, { error: '文件过大（图片≤6MB，音频≤12MB，文件≤20MB）' }); return; }
  const filename = String(body['filename'] ?? 'upload').replace(/[\r\n]/g, '').slice(0, 200);
  const mime = inferUploadMime(filename, String(body['mime'] ?? ''));
  const dataB64 = String(body['data_base64'] ?? '');
  const kind = UPLOAD_MIME.test(mime) ? 'image' : AUDIO_UPLOAD_MIME.test(mime) ? 'audio' : FILE_UPLOAD_MIME.test(mime) ? 'file' : '';
  if (!kind) { send(res, 415, { error: '仅支持图片、常见音频、PDF / Office / CSV / TSV / TXT / Markdown / JSON / 日志等文件' }); return; }
  if (dataB64.length < 16) { send(res, 400, { error: '文件内容为空' }); return; }
  const buf = Buffer.from(dataB64, 'base64');
  if (!buf.length) { send(res, 400, { error: '文件内容无法解码' }); return; }
  const maxBytes = kind === 'audio' ? 12 * 1024 * 1024 : kind === 'file' ? 20 * 1024 * 1024 : 6 * 1024 * 1024;
  if (buf.length > maxBytes) {
    send(res, 413, { error: kind === 'audio' ? '音频过大（最大 12MB）' : kind === 'file' ? '文件过大（最大 20MB）' : '图片过大（最大 6MB）' });
    return;
  }

  const auditId = `upload_${randomUUID()}`;
  const key = objectKey(bucket, entryKey, mime);
  try {
    const url = await putObject(bucket, key, buf, mime, { root: deps.cfg.root });
    await store.appendAudit({ ts: deps.now(), job_id: auditId, request_id: auditId, event: 'chat_upload',
      detail: { entry: entryKey, bucket: bucket.name, storage: bucket.kind, key, bytes: buf.length, mime, type: kind } }).catch(() => undefined);
    send(res, 200, { ok: true, url, name: filename, type: kind });
  } catch (e) {
    await store.appendAudit({ ts: deps.now(), job_id: auditId, request_id: auditId, event: 'chat_upload_error',
      detail: { entry: entryKey, bucket: bucket.name, storage: bucket.kind, error: String(e).slice(0, 300) } }).catch(() => undefined);
    send(res, 502, { error: '上传失败，请稍后再试' });
  }
}

/** 评价回答（运营反馈闭环）：只能评自己问出来的那条；一答一评，重评覆盖。 */
export async function handleChatRateFor(deps: ChatApiDeps, req: IncomingMessage, res: ServerResponse, entryKey: string, jobId: string): Promise<void> {
  const { state: store, config: cfgStore } = await chatRuntime(deps, jobId);
  if (!cfgStore) { send(res, 400, { error: '聊天入口需要 mysql 后端' }); return; }
  const entry = await cfgStore.chatEntries.get(entryKey);
  if (!entry || !entry.enabled) { send(res, 404, { error: '聊天入口不存在或已停用' }); return; }
  if (!chatOriginAllowed(entry, req)) { send(res, 403, { error: '该站点未被允许嵌入此聊天入口' }); return; }
  if (await chatRateLimited(cfgStore, entry, ipOf(req))) { send(res, 429, { error: '操作太频繁，请稍后再试' }); return; }
  const body = (await readBody(req).catch(() => ({} as Record<string, unknown>)));
  const rating = body['rating'] === 'up' ? 'up' : body['rating'] === 'down' ? 'down' : body['rating'] === 'note' ? 'note' : null;
  const comment = String(body['comment'] ?? '').trim().slice(0, 500);
  if (!rating) { send(res, 400, { error: 'rating 必须是 up、down 或 note' }); return; }
  if (rating === 'note' && !comment) { send(res, 400, { error: '文字反馈不能为空' }); return; }
  const visitor = String(body['visitor_id'] ?? '');
  const job = await store.getJob(jobId);
  // 归属双校验：本入口发起的 + 本访客问的（别人答案不能替评）
  if (!job || (job.metadata ?? {})['chat_entry'] !== entryKey || !visitor || (job.metadata ?? {})['visitor_id'] !== visitor) {
    send(res, 404, { error: 'not found' }); return;
  }
  await cfgStore.chatEntries.upsertJobRating({
    job_id: jobId, entry_key: entryKey, visitor_id: visitor, rating,
    comment: comment || undefined,
  });
  await store.appendAudit({ ts: deps.now(), job_id: jobId, request_id: job.request_id, event: 'chat_rated', detail: { rating, has_comment: !!comment } });
  send(res, 200, { ok: true, rating });
}

/** 验访客票据：v1.<b64url({uid,exp})>.<hmac_sha256_hex(接入方token, b64url)>。业务后端在登录态里签发，组件携带——身份在服务端可信代码确立，不经浏览器伪造。 */
function verifyVisitorTicket(ticket: string, secret: string): { uid: string } | null {
  const m = ticket.match(/^v1\.([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/);
  if (!m) return null;
  const expect = Buffer.from(createHmac('sha256', secret).update(m[1]!).digest('hex'));
  const got = Buffer.from(m[2]!);
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')); } catch { return null; }
  const uid = String(payload['uid'] ?? '').trim().slice(0, 64);
  const exp = Number(payload['exp'] ?? 0);
  if (!uid || !Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  return { uid };
}

export async function handleChatConfigFor(deps: ChatApiDeps, req: IncomingMessage, res: ServerResponse, entryKey: string): Promise<void> {
  const { config: cfgStore } = await chatRuntime(deps, `chat_config:${entryKey}`);
  if (!cfgStore) { send(res, 400, { error: '聊天入口需要 mysql 后端' }); return; }
  const entry = await cfgStore.chatEntries.get(entryKey);
  if (!entry) { send(res, 404, { error: '聊天入口不存在' }); return; }
  if (!chatOriginAllowed(entry, req)) { send(res, 403, { error: '该站点未被允许嵌入此聊天入口' }); return; }
  if (!entry.enabled) { send(res, 200, { enabled: false }); return; }
  // 附件上传开关：默认使用内置本地媒体存储；配置外部对象存储只是生产增强，不再是功能硬前置。
  const upload = true;
  // 外观：服务端套默认值后扁平下发，组件直接用（缺省也保留组件内置兜底）
  const ap = entry.appearance ?? {};
  send(res, 200, {
    enabled: true,
    title: entry.title || entry.name, greeting: entry.greeting ?? '', color: entry.color || '#7a5b3a', brand: deps.cfg.brand.name, upload,
    width: ap.width ?? 400, height: ap.height ?? 600,
    title_align: ap.title_align === 'left' ? 'left' : 'center',
    position: ap.position === 'left' ? 'left' : 'right',
    offset_x: ap.offset_x ?? 24, offset_y: ap.offset_y ?? 24,
    avatar: ap.avatar ?? '', launcher_icon: ap.launcher_icon ?? '',
    resizable: ap.resizable === true,
    ai_notice: ap.ai_notice !== false,
    powered_by_visible: ap.powered_by_visible !== false,
    powered_by_text: ap.powered_by_text || `由 ${deps.cfg.brand.name} 驱动`,
  });
}

/** 演示页：贴一行 script 的效果，建好入口立即可看（也是给第三方的"先试再接"入口）。 */
export function serveChatDemoFor(deps: Pick<ChatApiDeps, 'cfg'>, res: ServerResponse, entryKey: string): void {
  const html = [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>聊天入口演示 · ${deps.cfg.brand.name}</title></head>`,
    '<body style="margin:0;min-height:100vh;background:#faf9f7;font:15px/1.7 -apple-system,\'PingFang SC\',sans-serif;color:#3d372f">',
    '<div style="max-width:560px;margin:0 auto;padding:48px 24px">',
    '<h2 style="margin:0 0 8px">聊天入口演示页</h2>',
    '<p style="color:#8a8378">右下角的气泡就是嵌入效果。把下面这行代码贴进你网站任意页面的 &lt;/body&gt; 前即可：</p>',
    `<pre style="background:#fff;border:1px solid #e8e4dd;border-radius:8px;padding:12px;overflow:auto;font-size:12px">&lt;script src="<span data-host></span>/widget.js" data-entry="${entryKey}" async&gt;&lt;/script&gt;</pre>`,
    '</div>',
    '<script>document.querySelector("[data-host]").textContent=location.origin;</script>',
    `<script src="/widget.js" data-entry="${entryKey}" data-open="1" async></script>`,
    '</body></html>',
  ].join('\n');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(html);
}
