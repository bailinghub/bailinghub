// 工具语义检索索引（工具 RAG）：工具源的每个 AI 工具（名+描述+scope）→ embedding，派发时按用户输入余弦召回 top-K。
// 角色：根治「工具一多（> 内联阈值）就藏到 find_tools 后面、模型不主动翻菜单」的结构性失败——
//   由中枢替模型选出相关工具直接内联，工具总数随便涨到上千，大脑每轮只看到一小撮高度相关、可直接调用的定义。
// 边界：本模块只做「相关性排序」。治理（双闸/主体锁/审批/限流/签名/审计）全在 tools-runtime + tools 层，
//   检索只在「已过双闸的工具集（allowedNames）」内排序挑选，绝不可能让白名单外/主体锁定的工具被召回。
// 向量基建复用 kb.ts（embedViaApi/normalize/dot 同一出口，避免漂移）；存储复刻 008_kb.sql 的 float32 L2 归一化暴力余弦。
// 凭证按名解析 bz_credentials（kind embedding/both），无硬编码默认——未配凭证 = 检索关闭，调用方降级到目录+find_tools。
import { createHash } from 'node:crypto';
import type { AppConfig } from '../core/config/config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { ToolProvider } from '../core/contracts/types';
import { compileOpenApiTools } from '../core/contracts/openapi-tools';
import type { ToolDefinition } from '../core/contracts/tool-definition';
import { dot, embedViaApi } from './kb';
import type { ToolEmbeddingRepository } from './tool-index-repository';

const INDEX_TTL_MS = 10 * 60_000; // 内存索引兜底过期；reindex 主动失效，TTL 只防外部直改库

/** 工具检索的 embedding 坐标系（凭证名 + 模型 + 维度）。凭证名按名解析 bz_credentials，无硬编码。 */
export interface ToolEmbedConfig { credential: string; model: string; dim: number }
export interface ToolHit { name: string; scope: string; score: number }
export interface RetrieveOpts { minScore: number; maxTools: number }

/** 工具的语义面 = 名 + 描述（已含 summary/when-to-use/returns）+ 类别(scope)。检索准不准全靠这段。 */
function embedText(t: ToolDefinition): string {
  return `${t.name}\n${t.description}\n类别：${t.scope}`;
}
function textHash(s: string): string { return createHash('md5').update(s).digest('hex'); }
function dt(): string { return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''); }

interface IdxRow { tool_name: string; scope: string; vec: Float32Array }

export class ToolIndexService {
  private cache = new Map<string, { at: number; rows: IdxRow[] }>();

  constructor(
    private readonly store: ConfigStoreContract,
    private readonly cfg: AppConfig,
    private readonly embeddings: ToolEmbeddingRepository,
  ) {}

  /** embedding 凭证解析：与 KB 同源——bz_credentials（kind embedding/both，后台可配）优先，回退 config.json llm_credentials。无硬编码默认。 */
  private async resolveCred(name: string): Promise<{ base_url: string; api_key: string } | null> {
    if (!name) return null;
    const c = await this.store.credentials.get(name).catch(() => null);
    if (c && c.enabled && (c.kind === 'embedding' || c.kind === 'both')) {
      void this.store.credentials.touch(name).catch(() => { /* 观测字段 */ });
      return { base_url: c.base_url, api_key: c.api_key };
    }
    return this.cfg.llmCredentials[name] ?? null;
  }

  /**
   * 建/增量索引：未变的工具跳过重嵌（按 text_hash），新增/改动的重嵌，移除的删向量；
   * 模型/维度变了（坐标系变）整源删后重建。返回变更明细供审计/控制台展示。
   * 凭证不可用 / 无 spec 抛错——调用方（手动重建按钮 / spec 自动刷新钩子）捕获并降级，不阻塞主流程。
   */
  async reindexProvider(p: ToolProvider, ec: ToolEmbedConfig): Promise<{ added: string[]; changed: string[]; removed: string[]; unchanged: number; total: number }> {
    if (!ec.credential) throw new Error('未配置 embedding 凭证（工具检索未开启）');
    if (!p.spec_json) throw new Error(`工具源 ${p.name} 无 spec（先刷新/粘贴）`);
    const cred = await this.resolveCred(ec.credential);
    if (!cred) throw new Error(`embedding 凭证不可用: ${ec.credential}（先在「模型凭证」里添加，用途含向量化）`);
    const tools = compileOpenApiTools(p.spec_json).tools;

    // 现有索引快照 + 坐标系核对（任一行模型/维度与本次不符 = 坐标系变，整源重建）
    const exist = await this.embeddings.listSnapshot(p.name);
    const prev = new Map<string, string>(); // tool_name → text_hash
    let coordChanged = false;
    for (const r of exist) {
      if (r.model !== ec.model || r.dim !== ec.dim) coordChanged = true;
      prev.set(r.tool_name, r.text_hash);
    }
    if (coordChanged) { await this.embeddings.deleteProvider(p.name); prev.clear(); }

    const want = new Map<string, { t: ToolDefinition; text: string; hash: string }>();
    for (const t of tools) { const text = embedText(t); want.set(t.name, { t, text, hash: textHash(text) }); }

    const toEmbed: Array<{ name: string; scope: string; text: string; hash: string }> = [];
    const added: string[] = []; const changed: string[] = [];
    for (const [name, w] of want) {
      const ph = prev.get(name);
      if (ph === undefined) { added.push(name); toEmbed.push({ name, scope: w.t.scope, text: w.text, hash: w.hash }); }
      else if (ph !== w.hash) { changed.push(name); toEmbed.push({ name, scope: w.t.scope, text: w.text, hash: w.hash }); }
    }
    const removed = [...prev.keys()].filter((n) => !want.has(n));

    if (toEmbed.length) {
      const vecs = await embedViaApi(cred, ec.model, ec.dim, toEmbed.map((e) => e.text));
      for (let i = 0; i < toEmbed.length; i++) {
        const e = toEmbed[i]!; const v = vecs[i]!;
        await this.embeddings.upsert({
          provider: p.name,
          tool_name: e.name,
          scope: e.scope,
          text: e.text,
          text_hash: e.hash,
          model: ec.model,
          dim: ec.dim,
          embedding: Buffer.from(v.buffer, v.byteOffset, v.byteLength),
          updated_at: dt(),
        });
      }
    }
    await this.embeddings.deleteTools(p.name, removed);
    this.cache.delete(p.name);
    return { added, changed, removed, unchanged: want.size - added.length - changed.length, total: want.size };
  }

  /** 整源向量载内存（逐元素读：mysql2 的 Buffer 偏移可能非 4 字节对齐，直接套 Float32Array 视图会炸）。 */
  private async loadIndex(provider: string): Promise<IdxRow[]> {
    const hit = this.cache.get(provider);
    if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.rows;
    const rows = await this.embeddings.listVectors(provider);
    const parsed: IdxRow[] = rows.map((r) => {
      const buf = r.embedding;
      const vec = new Float32Array(Math.floor(buf.length / 4));
      for (let i = 0; i < vec.length; i++) vec[i] = buf.readFloatLE(i * 4);
      return { tool_name: r.tool_name, scope: r.scope, vec };
    });
    this.cache.set(provider, { at: Date.now(), rows: parsed });
    return parsed;
  }

  /**
   * 检索：在 allowedNames（已过双闸的工具集）内按用户输入余弦排序，分数门槛 + 上限封顶 + top-1 保底。
   * 返回 null = 该源无可用索引（没建/凭证不可用/都不在白名单）→ 调用方降级到目录+find_tools（零回归）。
   * 返回 [] 不会发生（至少 top-1 保底）；空集只可能因 allowedNames 与索引完全不相交 → 走 null 分支。
   */
  async retrieve(providerName: string, allowedNames: Set<string>, query: string, ec: ToolEmbedConfig, opts: RetrieveOpts): Promise<ToolHit[] | null> {
    if (!ec.credential || !query.trim()) return null;
    const rows = (await this.loadIndex(providerName)).filter((r) => allowedNames.has(r.tool_name));
    if (!rows.length) return null; // 未建索引或全不在白名单 → 降级
    const cred = await this.resolveCred(ec.credential);
    if (!cred) return null;
    const [qv] = await embedViaApi(cred, ec.model, ec.dim, [query.slice(0, 2000)]);
    if (!qv) return null;
    const scored = rows.map((r) => ({ name: r.tool_name, scope: r.scope, score: dot(qv, r.vec) }));
    scored.sort((a, b) => b.score - a.score);
    const cap = Math.min(Math.max(opts.maxTools || 15, 1), 40);
    const picked = scored.filter((h) => h.score >= opts.minScore).slice(0, cap);
    if (!picked.length) picked.push(scored[0]!); // top-1 保底：最佳匹配略低于门槛也给一个，避免静默零召回
    return picked.map((h) => ({ name: h.name, scope: h.scope, score: Math.round(h.score * 1000) / 1000 }));
  }

  /** 丢弃某源的内存索引缓存（spec 刷新/重建后调用，让下次检索读新向量）。 */
  invalidate(provider: string): void { this.cache.delete(provider); }
}
