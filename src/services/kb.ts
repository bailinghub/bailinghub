// 知识库（图书馆）：文档→切块→embedding→暴力余弦检索。
// 角色宪法：图书馆只在「资料路径」（派发前检索注入 / 纯检索 API），绝不在「对话路径」上（不持有会话、不直面用户）。
// 量级账：1 万 chunk × 1024 维 × 4 字节 = 40MB 内存、全扫 <10ms——向量库是十万 chunk 以后的事。
import { createHash } from 'node:crypto';
import type { AppConfig } from '../core/config/config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { KbBase, KbDoc } from '../core/contracts/types';
import type { KbHit } from '../core/runtime/knowledge-runtime';
import { dt } from '../core/config/config-codec';
import type { KnowledgeRepository } from './kb-repository';

const EMBED_BATCH = 10;            // DashScope text-embedding-v3/v4 单请求上限 10 条，按下限走最稳
const CHUNK_MAX = 700;             // 切块目标长度（字符）；中文 ≈ 500~700 token，远低于模型 8192 上限
const INDEX_TTL_MS = 10 * 60_000;  // 内存索引兜底过期；写路径会主动失效，TTL 只防外部直改库

/** 文本切块：按空行/markdown 标题分段，段落聚合到目标长度；超长段按句末标点切，单句仍超长才硬切。 */
export function chunkText(text: string, maxLen = CHUNK_MAX): string[] {
  const raw = text.replace(/\r\n/g, '\n').split(/\n{2,}|\n(?=#{1,6}\s)/).map((s) => s.trim()).filter(Boolean);
  // 标题黏住下一段：否则"## 常见问题"会孤悬在上一块的尾部，和它的内容分家
  const paras: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i]!;
    if (/^#{1,6}\s/.test(p) && !p.includes('\n') && i + 1 < raw.length) paras.push(p + '\n' + raw[++i]!);
    else paras.push(p);
  }
  const out: string[] = [];
  let buf = '';
  const flush = (): void => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const p of paras) {
    if (p.length > maxLen) {
      flush();
      for (const s of p.split(/(?<=[。！？!?；;\n])/)) {
        if (buf.length + s.length > maxLen) flush();
        if (s.length > maxLen) {
          flush();
          for (let i = 0; i < s.length; i += maxLen) out.push(s.slice(i, i + maxLen));
        } else buf += s;
      }
      flush();
    } else if (buf.length + p.length + 1 > maxLen) {
      flush(); buf = p;
    } else {
      buf = buf ? buf + '\n' + p : p;
    }
  }
  flush();
  return out;
}

// HTML 实体解码（覆盖富文本编辑器常见的几个；数字实体全收）。
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…', middot: '·', times: '×', copy: '©', reg: '®',
};
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => { try { return String.fromCodePoint(Number(d)); } catch { return _m; } })
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _m; } })
    .replace(/&([a-z]+);/gi, (_m, n: string) => NAMED_ENTITIES[n.toLowerCase()] ?? _m);
}

/** 内容像 HTML 吗？要求出现块级/换行标签或成对闭合标签——零散的 < > 或代码片段里的尖括号不误伤。 */
function looksLikeHtml(s: string): boolean {
  return /<(p|div|h[1-6]|br|ul|ol|li|table|tr|td|th|section|article|blockquote|span)[\s>/]/i.test(s)
    || /<\/(p|div|h[1-6]|ul|ol|li|table|tr|td|th)>/i.test(s);
}

/** HTML → markdown（零依赖，覆盖富文本编辑器输出的常见子集）。目的是喂给切块器+向量模型的干净文本，
 * 不追求像素级还原；标题转 # 让切块器按标题分段，链接/图片转 markdown 让聊天组件能渲染。 */
export function htmlToMarkdown(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '');
  // 先转图片/链接（避免后面被标签剥除吞掉 src/href）
  s = s.replace(/<img[^>]*?\balt=["']([^"']*)["'][^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi, '![$1]($2)');
  s = s.replace(/<img[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi, '![]($1)');
  s = s.replace(/<a[^>]*?\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, txt: string) => `[${txt.replace(/<[^>]+>/g, '').trim()}](${href})`);
  // 行内强调先于块级处理（**/*  无尖括号，能扛住后续标签剥除）
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t: string, txt: string) => `**${txt.replace(/<[^>]+>/g, '').trim()}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t: string, txt: string) => `*${txt.replace(/<[^>]+>/g, '').trim()}*`);
  // 标题 → #；列表项 → -；表格单元格用 | 连，行末换行
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, txt: string) => `\n\n${'#'.repeat(Number(lvl))} ${txt.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, txt: string) => `\n- ${txt.replace(/<[^>]+>/g, '').trim()}`);
  s = s.replace(/<\/(td|th)>/gi, ' | ').replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|blockquote|tr|h[1-6]|ul|ol)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');              // 剥除剩余标签
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/** 入库清洗：①像 HTML 的内容自动转 markdown（标签污染向量+气泡，三种来路统一处理）；
 * ②内嵌 base64 图片（data URI）替换为占位——知识库不存图片数据（撑爆字段/污染切块/向量无意义）。
 * http(s) 图片链接原样保留：检索命中后随资料注入，AI 可在回答里带出，聊天组件负责渲染。 */
export function sanitizeDocContent(text: string): string {
  const s = looksLikeHtml(text) ? htmlToMarkdown(text) : text;
  return s.replace(/!\[([^\]]*)\]\(\s*data:[^)]*\)/g, (_m, alt: string) => `[图：${alt || '嵌入图片'}（已略，请改用图片链接）]`);
}

/** 内容指纹：title 或 content 任一变化都该重嵌（title 随块入检索结果展示）。 */
function docHash(title: string, content: string): string {
  return createHash('md5').update(title).update('\x00').update(content).digest('hex');
}

/** embedding 入参降噪：图片 markdown 换成短占位（URL 对语义检索是噪音还费 token）。只影响送给向量模型的文本，落库内容保持原样。 */
function stripImagesForEmbedding(text: string): string {
  return text.replace(/!\[([^\]]*)\]\(\s*[^)]*\)/g, (_m, alt: string) => (alt ? `[图：${alt}]` : ''));
}

export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** OpenAI 兼容 /embeddings 调用（分批），返回 L2 归一化向量。KB 与工具检索（tools-index）共用同一出口，避免向量基建漂移。 */
export async function embedViaApi(cred: { base_url: string; api_key: string }, model: string, dim: number, texts: string[]): Promise<Float32Array[]> {
  const url = `${cred.base_url.replace(/\/$/, '')}/embeddings`;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const body: Record<string, unknown> = { model, input: batch };
    if (dim) body['dimensions'] = dim;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.api_key}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`embedding API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = (await resp.json()) as { data?: Array<{ index: number; embedding: number[] }> };
    const items = data?.data ?? [];
    if (items.length !== batch.length) throw new Error(`embedding 返回条数不符：要 ${batch.length} 得 ${items.length}`);
    items.sort((a, b) => a.index - b.index);
    for (const it of items) out.push(normalize(Float32Array.from(it.embedding)));
  }
  return out;
}

interface IndexRow { id: number; doc_id: number; seq: number; content: string; title: string; vec: Float32Array }

export class KbService {
  private indexCache = new Map<string, { at: number; rows: IndexRow[] }>();

  constructor(private readonly store: ConfigStoreContract, private readonly cfg: AppConfig, private readonly repository: KnowledgeRepository) {}

  /** embedding 凭证解析：bz_credentials（后台可配）优先，回退 config.json llm_credentials。 */
  private async resolveCred(name: string): Promise<{ base_url: string; api_key: string } | null> {
    const c = await this.store.credentials.get(name).catch(() => null);
    if (c && c.enabled && (c.kind === 'embedding' || c.kind === 'both')) {
      void this.store.credentials.touch(name).catch(() => { /* 观测字段 */ });
      return { base_url: c.base_url, api_key: c.api_key };
    }
    return this.cfg.llmCredentials[name] ?? null;
  }

  // ---- 知识库 ----
  async listBases(): Promise<Array<KbBase & { doc_count: number; chunk_count: number }>> {
    return this.repository.listBases();
  }

  async getBase(kbId: string): Promise<KbBase | null> {
    return this.repository.getBase(kbId);
  }

  /** 建库/改库。已存在时只更新 name/description/writers/enabled——credential/model/dim 跟向量坐标系绑定，改它=全库重算，本接口不开这个口（试图改这三项时显式报错，不静默忽略）。 */
  async upsertBase(b: KbBase): Promise<void> {
    if (!(await this.resolveCred(b.credential))) throw new Error(`embedding 凭证不可用: ${b.credential}（先在「模型凭证」里添加，用途含向量化）`);
    const existing = await this.getBase(b.kb_id);
    if (existing && (existing.credential !== b.credential || existing.model !== b.model || Number(existing.dim) !== Number(b.dim))) {
      throw new Error('知识库的 embedding 凭证 / 模型 / 维度建库后锁定（决定向量坐标系，改它=全库重算），如需更换请重建知识库');
    }
    await this.repository.upsertBase(b, dt());
  }

  async deleteBase(kbId: string): Promise<void> {
    await this.repository.deleteBase(kbId);
    this.indexCache.delete(kbId);
  }

  // ---- 文档 ----
  async listDocs(kbId: string): Promise<KbDoc[]> {
    return this.repository.listDocs(kbId);
  }

  /** 加文档：原文落库即返回，向量化后台跑（大文档几十块=多批 API 调用，别让 admin 请求挂着等）。 */
  async addDoc(kbId: string, title: string, content: string): Promise<number> {
    const base = await this.getBase(kbId);
    if (!base) throw new Error(`未知知识库: ${kbId}`);
    const clean = sanitizeDocContent(content);
    const docId = await this.repository.insertDoc(kbId, title, clean, docHash(title, clean), dt());
    void this.embedDoc(docId).catch(() => { /* 状态已落库（error），不抛 */ });
    return docId;
  }

  /** 入库插座：按外部源幂等键 upsert（接入方推送 / 数据源连接器共用此管道）。
   * 内容指纹未变且已就绪 → 跳过重嵌（业务 cron 每日全量重推 / 连接器每小时拉取时省下 embedding 费）；
   * awaitEmbed=true 时串行等嵌入完成（连接器批量同步用：天然限住对 embedding API 的并发）。 */
  async upsertDocByKey(kbId: string, sourceKey: string, title: string, content: string, opts?: { awaitEmbed?: boolean }): Promise<{ doc_id: number; created: boolean; skipped: boolean }> {
    const base = await this.getBase(kbId);
    if (!base) throw new Error(`未知知识库: ${kbId}`);
    const clean = sanitizeDocContent(content);
    const hash = docHash(title, clean);
    const existing = await this.repository.getDocSourceSnapshot(kbId, sourceKey);
    let docId: number; let created: boolean;
    if (existing) {
      const ex = existing;
      docId = Number(ex.doc_id); created = false;
      if (ex.content_hash === hash && ex.status === 'ready') return { doc_id: docId, created, skipped: true }; // 没变不重嵌；error 态不跳过（重试通道）
      await this.repository.updateDocForEmbedding(docId, title, clean, hash, dt());
    } else {
      docId = await this.repository.insertDocBySourceKey(kbId, sourceKey, title, clean, hash, dt());
      created = true;
    }
    if (opts?.awaitEmbed) await this.embedDoc(docId).catch(() => { /* 状态已落库（error），批量同步继续下一篇 */ });
    else void this.embedDoc(docId).catch(() => { /* 状态已落库（error），不抛 */ });
    return { doc_id: docId, created, skipped: false };
  }

  /** 连接器对账用：某前缀（ds{id}:）下现存的 source_key 集合。 */
  async listSourceKeysByPrefix(kbId: string, prefix: string): Promise<Map<string, number>> {
    return this.repository.listSourceKeysByPrefix(kbId, prefix);
  }

  /** 连接器退场清理：删除某前缀下全部文档与向量，返回删除篇数。 */
  async deleteDocsByPrefix(kbId: string, prefix: string): Promise<number> {
    const keys = await this.listSourceKeysByPrefix(kbId, prefix);
    for (const docId of keys.values()) {
      await this.deleteDoc(kbId, docId);
    }
    return keys.size;
  }

  /** 入库插座：按外部源幂等键删除。返回是否真的删到了。 */
  async deleteDocByKey(kbId: string, sourceKey: string): Promise<boolean> {
    const docId = await this.repository.getDocIdBySourceKey(kbId, sourceKey);
    if (!docId) return false;
    await this.deleteDoc(kbId, docId);
    return true;
  }

  /** 向量化一篇文档（可重跑：清旧块重算）。失败状态落库供后台展示。 */
  async embedDoc(docId: number): Promise<void> {
    const doc = await this.repository.getDoc(docId);
    if (!doc) return;
    try {
      const base = await this.getBase(String(doc.kb_id));
      if (!base) throw new Error(`知识库不存在: ${doc.kb_id}`);
      const cred = await this.resolveCred(base.credential);
      if (!cred) throw new Error(`embedding 凭证不可用: ${base.credential}`);
      // 先剥图再切块：图片链接（每条约 130 字）不占字数预算，避免图多文档被切成"满是链接、真文本只剩几十字"的碎块（检索不准）。
      // 块内容即落库即检索文本——存的就是干净正文；图片靠整篇注入模式从父文档带回（见 searchDocs）。
      const cleanText = stripImagesForEmbedding(String(doc.content ?? '')).replace(/\n{3,}/g, '\n\n').trim();
      const chunks = chunkText(cleanText);
      if (!chunks.length) throw new Error('文档内容为空（或全是图片），切不出有效文本块');
      const vecs = await embedViaApi(cred, base.model, base.dim, chunks.map((c) => c.trim() || ' '));
      await this.repository.replaceChunks(docId, chunks.map((chunk, i) => {
        const v = vecs[i]!;
        return {
          kb_id: doc.kb_id,
          doc_id: docId,
          seq: i,
          content: chunk,
          embedding: Buffer.from(v.buffer, v.byteOffset, v.byteLength),
          created_at: dt(),
        };
      }));
      await this.repository.markDocReady(docId, chunks.length, dt());
    } catch (e) {
      await this.repository.markDocError(docId, String(e).slice(0, 480), dt()).catch(() => { /* 尽力而为 */ });
      throw e;
    } finally {
      this.indexCache.delete(String(doc.kb_id));
    }
  }

  async deleteDoc(kbId: string, docId: number): Promise<void> {
    await this.repository.deleteDoc(kbId, docId);
    this.indexCache.delete(kbId);
  }

  // ---- 检索 ----
  async search(kbId: string, query: string, topK = 5, minScore = 0.35): Promise<KbHit[]> {
    const base = await this.getBase(kbId);
    if (!base || !base.enabled) throw new Error(`知识库不可用: ${kbId}`);
    const cred = await this.resolveCred(base.credential);
    if (!cred) throw new Error(`embedding 凭证不可用: ${base.credential}`);
    const [qv] = await embedViaApi(cred, base.model, base.dim, [query.slice(0, 4000)]);
    const idx = await this.loadIndex(kbId);
    const scored = idx.map((r) => ({ score: dot(qv!, r.vec), content: r.content, doc_id: r.doc_id, title: r.title, seq: r.seq }));
    scored.sort((a, b) => b.score - a.score);
    const k = Math.min(Math.max(topK || 5, 1), 20);
    return scored.slice(0, k).filter((h) => h.score >= minScore).map((h) => ({ ...h, score: Math.round(h.score * 1000) / 1000 }));
  }

  /** 整篇注入检索（small-to-big）：按块精确命中，再去重到父文档、回带整篇原文（含图片链接）。
   * 适合"一篇一主题"的短文档（帮助中心/操作指南）——命中一个薄块没用，给 AI 整篇才有完整上下文，截图也能随原文带回。 */
  async searchDocs(kbId: string, query: string, topK = 8, minScore = 0.35, maxDocs = 4, perDocCap = 8000): Promise<Array<{ doc_id: number; title: string; score: number; content: string }>> {
    const hits = await this.search(kbId, query, topK, minScore);
    const best = new Map<number, number>(); // doc_id → 最高分（块命中里取最高）
    for (const h of hits) if (!best.has(h.doc_id)) best.set(h.doc_id, h.score);
    const docIds = [...best.keys()].slice(0, Math.max(maxDocs, 1));
    if (!docIds.length) return [];
    const rows = await this.repository.listDocsByIds(docIds);
    const byId = new Map(rows.map((r) => [Number(r.doc_id), r]));
    return docIds.map((id) => {
      const d = byId.get(id);
      const full = String(d?.content ?? '');
      return { doc_id: id, title: String(d?.title ?? ''), score: best.get(id)!, content: full.length > perDocCap ? full.slice(0, perDocCap) + '…（原文过长已截断）' : full };
    });
  }

  /** 多库检索：每库各自检索（用各自 embedding 模型）→合并→按分数全局排序→取 topK。
   * 单库故障不拖垮其它库（降级跳过）。注意：跨库分数可比的前提是同 embedding 模型；混模型时为近似排序。 */
  async searchMulti(kbIds: string[], query: string, topK = 5, minScore = 0.35): Promise<Array<KbHit & { kb_id: string }>> {
    const all: Array<KbHit & { kb_id: string }> = [];
    for (const kbId of kbIds) {
      try {
        const hits = await this.search(kbId, query, topK, minScore);
        for (const h of hits) all.push({ ...h, kb_id: kbId });
      } catch { /* 单库不可用（停用/异常）跳过，不影响其它库 */ }
    }
    all.sort((a, b) => b.score - a.score);
    return all.slice(0, Math.min(Math.max(topK || 5, 1), 20));
  }

  /** 多库整篇注入：多库检索→去重父文档（doc_id 全局唯一）→回带整篇原文。 */
  async searchDocsMulti(kbIds: string[], query: string, topK = 8, minScore = 0.35, maxDocs = 4, perDocCap = 8000): Promise<Array<{ doc_id: number; title: string; score: number; content: string; kb_id: string }>> {
    const hits = await this.searchMulti(kbIds, query, topK, minScore);
    const best = new Map<number, { score: number; kb_id: string }>();
    for (const h of hits) if (!best.has(h.doc_id)) best.set(h.doc_id, { score: h.score, kb_id: h.kb_id });
    const docIds = [...best.keys()].slice(0, Math.max(maxDocs, 1));
    if (!docIds.length) return [];
    const rows = await this.repository.listDocsByIds(docIds);
    const byId = new Map(rows.map((r) => [Number(r.doc_id), r]));
    return docIds.map((id) => {
      const d = byId.get(id); const meta = best.get(id)!;
      const full = String(d?.content ?? '');
      return { doc_id: id, title: String(d?.title ?? ''), score: meta.score, kb_id: meta.kb_id, content: full.length > perDocCap ? full.slice(0, perDocCap) + '…（原文过长已截断）' : full };
    });
  }

  private async loadIndex(kbId: string): Promise<IndexRow[]> {
    const hit = this.indexCache.get(kbId);
    if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.rows;
    const rows = await this.repository.listIndexRows(kbId);
    const parsed: IndexRow[] = rows.map((r) => {
      const buf = r.embedding as Buffer;
      // 逐元素读：mysql2 的 Buffer 可能落在共享池的非 4 字节对齐偏移上，直接套 Float32Array 视图会炸
      const vec = new Float32Array(Math.floor(buf.length / 4));
      for (let i = 0; i < vec.length; i++) vec[i] = buf.readFloatLE(i * 4);
      return { id: Number(r.id), doc_id: Number(r.doc_id), seq: Number(r.seq), content: String(r.content), title: String(r.title ?? ''), vec };
    });
    this.indexCache.set(kbId, { at: Date.now(), rows: parsed });
    return parsed;
  }
}
