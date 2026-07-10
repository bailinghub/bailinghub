// 知识库 API：纯检索（/kb/search，不在对话路径只还料）+ 入库插座（接入方按外部源幂等键推/删/对账文档）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, readBody, send } from '../app/http';
import { type Principal, rateLimitedFor } from '../app/auth';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { KbService } from '../services/kb';

export interface KbApiDeps {
  kbService: KbService | null;
  stateStore: RuntimeStateStore;
  configStore: ConfigStoreContract | null;
  now: () => string;
}

/** 纯检索 API（开放给接入方/大脑做资料查询；图书馆不在对话路径，这里只还原料不做问答）。 */
export async function handleKbSearchFor(deps: KbApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const knowledge = deps.kbService;
  if (!knowledge) { send(res, 400, { error: '知识库需要 mysql 后端' }); return; }
  const b = (await readBody(req)) as Record<string, unknown>;
  // kb_id 单值 或 kb_ids 数组（多库合并检索）
  const kbIds = Array.isArray(b['kb_ids'])
    ? (b['kb_ids'] as unknown[]).map((x) => String(x).trim()).filter(Boolean)
    : (b['kb_id'] ? [String(b['kb_id']).trim()] : []);
  const query = String(b['query'] ?? '').trim();
  if (!kbIds.length || !query) { send(res, 400, { error: 'kb_id（或 kb_ids）/ query 必填' }); return; }
  // 校验请求的库存在：全部不存在 → 400（CONTRACT §2.1「知识库不可用返回 400」，调用方据此降级）；
  // 部分存在则按多库设计只检索存在的、跳过缺失者（单库故障不连累其它库）。多库 refactor 后曾静默跳过=违约，已补回。
  const valid: string[] = [];
  for (const id of kbIds) { if (await knowledge.getBase(id)) valid.push(id); }
  if (!valid.length) { send(res, 400, { error: `知识库不可用：${kbIds.join(', ')}` }); return; }
  try {
    const hits = await knowledge.searchMulti(valid, query.slice(0, 2000), Number(b['top_k'] ?? 5) || 5, Number(b['min_score'] ?? 0.35) || 0.35);
    send(res, 200, { kb_ids: valid, hits });
  } catch (e) {
    send(res, 400, { error: errMsg(e) });
  }
}

// ---- 知识库入库插座（v1.9）：接入方按外部源幂等键推/删/对账文档 ----
// 业务库内容（帮助中心/工单流程等）的入库正道：业务侧把行渲染成 markdown 主动推过来——中枢不猜业务 schema。
// 鉴权：admin 全能；接入方须在该库 writers 白名单（控制台「知识库 → 库设置」勾选）。
function kbWriteAllowed(p: Principal, base: { writers?: string[] }): boolean {
  return p.kind === 'admin' || (p.kind === 'client' && (base.writers ?? []).includes(p.client.app_id));
}

export async function handleKbIngestFor(deps: KbApiDeps, req: IncomingMessage, res: ServerResponse, p: Principal, method: string, kbId: string, sourceKey: string): Promise<void> {
  const knowledge = deps.kbService;
  if (!knowledge) { send(res, 400, { error: '知识库需要 mysql 后端' }); return; }
  const base = await knowledge.getBase(kbId);
  if (!base) { send(res, 404, { error: `未知知识库: ${kbId}` }); return; }
  if (!kbWriteAllowed(p, base)) { send(res, 403, { error: '该接入方不在此知识库的可写白名单（控制台「知识库 → 库设置 → 可写接入方」勾选后重试）' }); return; }
  // 写入限速共用 /run 桶：embedding 调用花的是真钱
  if (p.kind === 'client' && await rateLimitedFor(deps.configStore, p.client)) { send(res, 429, { error: `超出限速（${p.client.rate_limit_per_min}/分钟）` }); return; }
  const by = p.kind === 'client' ? p.client.app_id : 'admin';

  if (method === 'DELETE') {
    const found = await knowledge.deleteDocByKey(kbId, sourceKey);
    if (!found) { send(res, 404, { error: `该 source_key 不存在: ${sourceKey}` }); return; }
    await deps.stateStore.appendAudit({ ts: deps.now(), job_id: '-', request_id: 'kb-ingest', event: 'kb_doc_delete', detail: { kb_id: kbId, source_key: sourceKey, by } });
    send(res, 200, { ok: true });
    return;
  }
  // PUT：幂等 upsert（同 key 再推 = 覆盖原文 + 整篇重算向量）
  const b = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
  const title = String(b['title'] ?? '').trim();
  const content = String(b['content'] ?? '').trim();
  if (!title || !content) { send(res, 400, { error: 'title / content 必填（content = markdown 或纯文本）' }); return; }
  if (content.length > 300_000) { send(res, 400, { error: '单篇文档上限 30 万字符——一篇文档一个主题检索效果最好，请按主题拆分' }); return; }
  try {
    const r = await knowledge.upsertDocByKey(kbId, sourceKey, title.slice(0, 191), content);
    await deps.stateStore.appendAudit({
      ts: deps.now(), job_id: '-', request_id: 'kb-ingest', event: 'kb_doc_upsert',
      detail: { kb_id: kbId, source_key: sourceKey, doc_id: r.doc_id, created: r.created, chars: content.length, by },
    });
    send(res, 200, { ok: true, doc_id: r.doc_id, created: r.created, status: 'embedding' });
  } catch (e) { send(res, 400, { error: errMsg(e) }); }
}

/** 入库对账：接入方拉自己可写库的文档清单（source_key/状态/块数），核对推送是否生效、有无漏推。 */
export async function handleKbIngestListFor(deps: KbApiDeps, res: ServerResponse, p: Principal, kbId: string): Promise<void> {
  const knowledge = deps.kbService;
  if (!knowledge) { send(res, 400, { error: '知识库需要 mysql 后端' }); return; }
  const base = await knowledge.getBase(kbId);
  if (!base) { send(res, 404, { error: `未知知识库: ${kbId}` }); return; }
  if (!kbWriteAllowed(p, base)) { send(res, 403, { error: '该接入方不在此知识库的可写白名单' }); return; }
  const docs = await knowledge.listDocs(kbId);
  send(res, 200, {
    kb_id: kbId,
    docs: docs.map((d) => ({ source_key: d.source_key ?? null, doc_id: d.doc_id, title: d.title, status: d.status, chunk_count: d.chunk_count, updated_at: d.updated_at })),
  });
}
