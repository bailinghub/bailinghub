// 工具语义检索索引（工具 RAG）：工具源的每个 AI 工具（名+描述+scope）→ embedding，派发时按用户输入余弦召回 top-K。
// 角色：根治「工具一多（> 内联阈值）就藏到 find_tools 后面、模型不主动翻菜单」的结构性失败——
//   由中枢替模型选出相关工具直接内联，工具总数随便涨到上千，大脑每轮只看到一小撮高度相关、可直接调用的定义。
// 边界：本模块只做「相关性排序」。治理（双闸/主体锁/审批/限流/签名/审计）全在 tools-runtime + tools 层，
//   检索只在「已过双闸的工具集（allowedNames）」内排序挑选，绝不可能让白名单外/主体锁定的工具被召回。
// 向量基建复用 embedding.ts（embedViaApi/normalize/dot 同一出口，避免漂移）；存储复刻 008_kb.sql 的 float32 L2 归一化暴力余弦。
// 凭证按名解析 bz_credentials（kind embedding/both），无硬编码默认——未配凭证 = 检索关闭，调用方降级到目录+find_tools。
import { createHash } from 'node:crypto';
import { DEFAULT_TOOL_RETRIEVAL_CONFIG, type AppConfig } from '../core/config/config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { ToolProvider } from '../core/contracts/types';
import { compileOpenApiTools } from '../core/contracts/openapi-tools';
import type { ToolDefinition } from '../core/contracts/tool-definition';
import { runSerial, type SerialLease } from '../core/platform/serial';
import { dot, embedViaApi, EmbeddingRequestError } from './embedding';
import type { ToolEmbeddingRepository } from './tool-index-repository';

const INDEX_TTL_MS = 10 * 60_000; // 内存索引兜底过期；reindex 主动失效，TTL 只防外部直改库

/** 工具检索的 embedding 坐标系（凭证名 + 模型 + 维度）。凭证名按名解析 bz_credentials，无硬编码。 */
export interface ToolEmbedConfig { credential: string; model: string; dim: number }
export interface ToolHit { name: string; scope: string; score: number }
export interface ToolReindexResult { added: string[]; changed: string[]; removed: string[]; unchanged: number; total: number }
export type ToolRetrievalFailureReason =
  | 'index_load_timeout'
  | 'index_load_error'
  | 'index_empty'
  | 'no_eligible_tools'
  | 'credential_unavailable'
  | 'credential_timeout'
  | 'credential_error'
  | 'embedding_timeout'
  | 'embedding_error';
export type ToolIndexCacheState = 'fresh' | 'stale' | 'miss';
export interface ToolRetrievalObservation {
  provider: string;
  status: 'ok' | 'unavailable' | 'degraded';
  reason?: ToolRetrievalFailureReason;
  cache_state: ToolIndexCacheState;
  index_rows: number;
  eligible_rows: number;
  picked: number;
  index_load_ms: number;
  credential_ms: number;
  embedding_ms: number;
  total_ms: number;
}
export interface RetrieveOpts {
  minScore: number;
  maxTools: number;
  /** 任务级诊断出口；实现必须 best-effort，不能让观测失败阻塞检索。 */
  observe?: (observation: ToolRetrievalObservation) => void | Promise<void>;
}

export class ToolRetrievalError extends Error {
  override readonly name = 'ToolRetrievalError';

  constructor(public readonly reason: Extract<ToolRetrievalFailureReason, 'index_load_timeout' | 'index_load_error' | 'credential_timeout' | 'credential_error' | 'embedding_timeout' | 'embedding_error'>, message: string) {
    super(message);
  }
}

/** 工具的语义面 = 名 + 描述（已含 summary/when-to-use/returns）+ 类别(scope)。检索准不准全靠这段。 */
function embedText(t: ToolDefinition): string {
  return `${t.name}\n${t.description}\n类别：${t.scope}`;
}
function textHash(s: string): string { return createHash('md5').update(s).digest('hex'); }
function dt(): string { return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''); }

interface IdxRow { tool_name: string; scope: string; vec: Float32Array }
interface LoadedIndex { rows: IdxRow[]; cacheState: ToolIndexCacheState }

function elapsedMs(startedAt: number): number { return Math.max(0, Date.now() - startedAt); }

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTimeoutLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; name?: unknown; message?: unknown };
  return value.code === 'ETIMEDOUT' || value.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(String(value.message ?? ''));
}

export class ToolIndexService {
  private cache = new Map<string, { at: number; rows: IdxRow[] }>();
  private refreshes = new Map<string, Promise<IdxRow[]>>();
  private generations = new Map<string, number>();

  constructor(
    private readonly store: ConfigStoreContract,
    private readonly cfg: AppConfig,
    private readonly embeddings: ToolEmbeddingRepository,
    private readonly serialLease?: SerialLease,
    private readonly serialScope = '',
  ) {}

  private serialKey(provider: string): string {
    return `${this.serialScope ? `${this.serialScope}:` : ''}tool-index:${provider}`;
  }

  /** embedding 凭证解析：与 KB 同源——bz_credentials（kind embedding/both，后台可配）优先，回退 config.json llm_credentials。无硬编码默认。 */
  private async resolveCred(name: string, timeoutMs?: number): Promise<{ base_url: string; api_key: string } | null> {
    if (!name) return null;
    const fallback = this.cfg.llmCredentials[name] ?? null;
    let c;
    try {
      const pending = this.store.credentials.get(name, timeoutMs ? { timeoutMs } : undefined);
      c = timeoutMs
        ? await withDeadline(
            pending,
            timeoutMs,
            () => new ToolRetrievalError('credential_timeout', `embedding credential lookup timed out after ${timeoutMs} ms`),
          )
        : await pending;
    } catch (error) {
      if (fallback) return fallback;
      if (!timeoutMs) return null;
      if (error instanceof ToolRetrievalError) throw error;
      if (isTimeoutLike(error)) {
        throw new ToolRetrievalError('credential_timeout', `embedding credential lookup timed out after ${timeoutMs} ms`);
      }
      throw new ToolRetrievalError('credential_error', 'embedding credential lookup failed');
    }
    if (c && c.enabled && (c.kind === 'embedding' || c.kind === 'both')) {
      try { void Promise.resolve(this.store.credentials.touch(name)).catch(() => undefined); } catch { /* 观测字段 */ }
      return { base_url: c.base_url, api_key: c.api_key };
    }
    return fallback;
  }

  /**
   * 建/增量索引：未变的工具跳过重嵌（按 text_hash），新增/改动的重嵌，移除的删向量；
   * 模型/维度变了（坐标系变）整源删后重建。返回变更明细供审计/控制台展示。
   * 凭证不可用 / 无 spec 抛错——调用方（手动重建按钮 / spec 自动刷新钩子）捕获并降级，不阻塞主流程。
   */
  async reindexProvider(p: ToolProvider, ec: ToolEmbedConfig): Promise<ToolReindexResult> {
    return await runSerial(this.serialKey(p.name), async () => {
      const current = await this.currentReindexInput(p, ec);
      if (!current.embedConfig.credential) throw new Error('未配置 embedding 凭证（工具检索未开启）');
      if (!current.provider.spec_json) throw new Error(`工具源 ${current.provider.name} 无 spec（先刷新/粘贴）`);
      const cred = await this.resolveCred(current.embedConfig.credential);
      if (!cred) throw new Error(`embedding 凭证不可用: ${current.embedConfig.credential}（先在「模型凭证」里添加，用途含向量化）`);
      const tools = compileOpenApiTools(current.provider.spec_json).tools;
      return await this.reindexProviderLocked(current.provider, current.embedConfig, cred, tools);
    }, { lease: this.serialLease });
  }

  /**
   * 跨实例等锁期间 Provider 可能已被再次保存；锁内重读权威配置，防止旧请求后获锁反而覆盖新 spec/坐标系。
   * 不完整的测试/旧宿主注入可没有 toolProviders，此时保持传入参数的兼容语义。
   */
  private async currentReindexInput(p: ToolProvider, ec: ToolEmbedConfig): Promise<{ provider: ToolProvider; embedConfig: ToolEmbedConfig }> {
    const providers = this.store.toolProviders as ConfigStoreContract['toolProviders'] | undefined;
    if (!providers || typeof providers.get !== 'function') return { provider: p, embedConfig: ec };
    const latest = await providers.get(p.name);
    if (!latest) throw new Error(`工具源 ${p.name} 已删除`);
    const latestConfig = latest.embed_credential && latest.embed_model && latest.embed_dim
      ? { credential: latest.embed_credential, model: latest.embed_model, dim: latest.embed_dim }
      : null;
    if (!latestConfig) throw new Error(`工具源 ${p.name} 未完整配置 embedding 坐标系`);
    return { provider: latest, embedConfig: latestConfig };
  }

  /** 已持有 Provider 级串行锁后的临界区：快照、向量计算和持久化不得与另一次同源重建交错。 */
  private async reindexProviderLocked(
    p: ToolProvider,
    ec: ToolEmbedConfig,
    cred: { base_url: string; api_key: string },
    tools: ToolDefinition[],
  ): Promise<ToolReindexResult> {
    // 现有索引快照 + 坐标系核对（任一行模型/维度与本次不符 = 坐标系变，整源重建）
    const exist = await this.embeddings.listSnapshot(p.name);
    const prev = new Map<string, string>(); // tool_name → text_hash
    let coordChanged = false;
    for (const r of exist) {
      if (r.model !== ec.model || r.dim !== ec.dim) coordChanged = true;
      prev.set(r.tool_name, r.text_hash);
    }
    if (coordChanged) prev.clear();

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

    try {
      let vecs: Float32Array[] = [];
      if (toEmbed.length) vecs = await embedViaApi(cred, ec.model, ec.dim, toEmbed.map((e) => e.text));
      const staged = toEmbed.map((e, i) => {
        const v = vecs[i]!;
        return {
          provider: p.name,
          tool_name: e.name,
          scope: e.scope,
          text: e.text,
          text_hash: e.hash,
          model: ec.model,
          dim: ec.dim,
          embedding: Buffer.from(v.buffer, v.byteOffset, v.byteLength),
          updated_at: dt(),
        };
      });
      // 坐标系变化时先把全部新向量算完，再原子切换；外部 embedding 或数据库写入失败都不暴露部分索引。
      if (coordChanged && this.embeddings.replaceProvider) {
        await this.embeddings.replaceProvider(p.name, staged);
      } else if (coordChanged) {
        // 旧扩展仓储仍可读/增量更新原坐标，但不得用非原子 delete+逐行写切换坐标系。
        // 明确失败并保留旧数据；当前新坐标查不到向量时会安全退回渐进式发现。
        throw new Error('工具向量仓储不支持原子坐标系切换，请实现 replaceProvider 后重试');
      } else {
        for (const row of staged) await this.embeddings.upsert(row);
        await this.embeddings.deleteTools(p.name, removed);
      }
    } finally {
      this.invalidate(p.name);
    }
    return { added, changed, removed, unchanged: want.size - added.length - changed.length, total: want.size };
  }

  private cacheKey(provider: string, ec: ToolEmbedConfig): string {
    return JSON.stringify([provider, ec.model, ec.dim]);
  }

  /** 整源向量载内存（逐元素读：mysql2 的 Buffer 偏移可能非 4 字节对齐，直接套 Float32Array 视图会炸）。 */
  private refreshIndex(provider: string, ec: ToolEmbedConfig): Promise<IdxRow[]> {
    const key = this.cacheKey(provider, ec);
    const active = this.refreshes.get(key);
    if (active) return active;
    const generation = this.generations.get(provider) ?? 0;
    const timeoutMs = this.cfg.toolRetrieval?.indexLoadTimeoutMs ?? DEFAULT_TOOL_RETRIEVAL_CONFIG.indexLoadTimeoutMs;
    const refresh = (async () => {
      try {
        const rows = await withDeadline(
          this.embeddings.listVectors(provider, { model: ec.model, dim: ec.dim, timeoutMs }),
          timeoutMs,
          () => new ToolRetrievalError('index_load_timeout', `tool index load timed out after ${timeoutMs} ms`),
        );
        const coordinateMismatch = rows.some((row) => (
          row.model !== ec.model
          || row.dim !== ec.dim
          || row.embedding.length !== ec.dim * 4
        ));
        // 旧扩展可能忽略 listVectors 的可选坐标查询，或不回传行级坐标。任何无法由同一次读取
        // 证明坐标一致的行都使本次索引整体失效；不能用另一次可变快照来猜测这批向量的坐标。
        // 让调用方安全降级到 catalog + find_tools，绝不混用不同模型或维度做点积。
        if (coordinateMismatch) return [];
        const parsed: IdxRow[] = rows.map((r) => {
          const buf = r.embedding;
          const vec = new Float32Array(ec.dim);
          for (let i = 0; i < vec.length; i++) vec[i] = buf.readFloatLE(i * 4);
          return { tool_name: r.tool_name, scope: r.scope, vec };
        });
        if ((this.generations.get(provider) ?? 0) !== generation) {
          throw new ToolRetrievalError('index_load_error', 'tool index changed while loading');
        }
        this.cache.set(key, { at: Date.now(), rows: parsed });
        return parsed;
      } catch (error) {
        if (error instanceof ToolRetrievalError) throw error;
        if (isTimeoutLike(error)) {
          throw new ToolRetrievalError('index_load_timeout', `tool index load timed out after ${timeoutMs} ms`);
        }
        throw new ToolRetrievalError('index_load_error', 'tool index load failed');
      }
    })();
    this.refreshes.set(key, refresh);
    void refresh.then(
      () => { if (this.refreshes.get(key) === refresh) this.refreshes.delete(key); },
      () => { if (this.refreshes.get(key) === refresh) this.refreshes.delete(key); },
    );
    return refresh;
  }

  /** 新鲜缓存直接用；过期缓存继续服务并后台刷新；只有真正冷启动才有界等待。 */
  private async loadIndex(provider: string, ec: ToolEmbedConfig): Promise<LoadedIndex> {
    const key = this.cacheKey(provider, ec);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < INDEX_TTL_MS) return { rows: hit.rows, cacheState: 'fresh' };
    if (hit) {
      void this.refreshIndex(provider, ec).catch(() => { /* stale-while-revalidate：旧缓存仍可服务，下次继续尝试 */ });
      return { rows: hit.rows, cacheState: 'stale' };
    }
    return { rows: await this.refreshIndex(provider, ec), cacheState: 'miss' };
  }

  /** 冷启动预热：只加载已建向量，不解析凭证、不请求 embedding；调用方应在后台 best-effort 触发。 */
  async prewarmProvider(provider: string, ec: ToolEmbedConfig): Promise<number> {
    return (await this.loadIndex(provider, ec)).rows.length;
  }

  /**
   * 检索：在 allowedNames（已过双闸的工具集）内按用户输入余弦排序，分数门槛 + 上限封顶 + top-1 保底。
   * 返回 null = 该源无可用索引（没建/凭证不可用/都不在白名单）→ 调用方降级到目录+find_tools（零回归）。
   * 返回 [] 不会发生（至少 top-1 保底）；空集只可能因 allowedNames 与索引完全不相交 → 走 null 分支。
   */
  async retrieve(providerName: string, allowedNames: Set<string>, query: string, ec: ToolEmbedConfig, opts: RetrieveOpts): Promise<ToolHit[] | null> {
    if (!ec.credential || !query.trim()) return null;
    const totalStartedAt = Date.now();
    let cacheState: ToolIndexCacheState = 'miss';
    let indexRows = 0;
    let eligibleRows = 0;
    let indexLoadMs = 0;
    let credentialMs = 0;
    let embeddingMs = 0;
    const observe = (status: ToolRetrievalObservation['status'], reason?: ToolRetrievalFailureReason, picked = 0): void => {
      if (!opts.observe) return;
      const observation: ToolRetrievalObservation = {
        provider: providerName,
        status,
        ...(reason ? { reason } : {}),
        cache_state: cacheState,
        index_rows: indexRows,
        eligible_rows: eligibleRows,
        picked,
        index_load_ms: indexLoadMs,
        credential_ms: credentialMs,
        embedding_ms: embeddingMs,
        total_ms: elapsedMs(totalStartedAt),
      };
      // 诊断是 best-effort 元数据：同步触发，绝不等待审计仓储，避免观测反过来阻塞可选检索。
      try { void Promise.resolve(opts.observe(observation)).catch(() => undefined); } catch { /* 同步 observer 失败也不阻塞 */ }
    };

    const indexStartedAt = Date.now();
    let loaded: LoadedIndex;
    try {
      loaded = await this.loadIndex(providerName, ec);
    } catch (error) {
      indexLoadMs = elapsedMs(indexStartedAt);
      const typed = error instanceof ToolRetrievalError
        ? error
        : new ToolRetrievalError('index_load_error', 'tool index load failed');
      observe('degraded', typed.reason);
      throw typed;
    }
    indexLoadMs = elapsedMs(indexStartedAt);
    cacheState = loaded.cacheState;
    indexRows = loaded.rows.length;
    if (!indexRows) {
      observe('unavailable', 'index_empty');
      return null;
    }
    const rows = loaded.rows.filter((r) => allowedNames.has(r.tool_name));
    eligibleRows = rows.length;
    if (!rows.length) {
      observe('unavailable', 'no_eligible_tools');
      return null; // 未建索引或全不在白名单 → 降级
    }
    const credentialStartedAt = Date.now();
    let cred: { base_url: string; api_key: string } | null;
    try {
      cred = await this.resolveCred(
        ec.credential,
        this.cfg.toolRetrieval?.indexLoadTimeoutMs ?? DEFAULT_TOOL_RETRIEVAL_CONFIG.indexLoadTimeoutMs,
      );
    } catch (error) {
      credentialMs = elapsedMs(credentialStartedAt);
      const typed = error instanceof ToolRetrievalError
        ? error
        : new ToolRetrievalError('credential_error', 'embedding credential lookup failed');
      observe('degraded', typed.reason);
      throw typed;
    }
    credentialMs = elapsedMs(credentialStartedAt);
    if (!cred) {
      observe('unavailable', 'credential_unavailable');
      return null;
    }
    const embeddingStartedAt = Date.now();
    let qv: Float32Array | undefined;
    try {
      [qv] = await embedViaApi(cred, ec.model, ec.dim, [query.slice(0, 2000)], {
        requestTimeoutMs: this.cfg.toolRetrieval?.embeddingTimeoutMs ?? DEFAULT_TOOL_RETRIEVAL_CONFIG.embeddingTimeoutMs,
      });
    } catch (error) {
      embeddingMs = elapsedMs(embeddingStartedAt);
      const typed = error instanceof EmbeddingRequestError && error.kind === 'timeout'
        ? new ToolRetrievalError('embedding_timeout', error.message)
        : new ToolRetrievalError('embedding_error', 'tool query embedding failed');
      observe('degraded', typed.reason);
      throw typed;
    }
    embeddingMs = elapsedMs(embeddingStartedAt);
    if (!qv) {
      const error = new ToolRetrievalError('embedding_error', 'tool query embedding returned no vector');
      observe('degraded', error.reason);
      throw error;
    }
    const scored = rows.map((r) => ({ name: r.tool_name, scope: r.scope, score: dot(qv, r.vec) }));
    scored.sort((a, b) => b.score - a.score);
    const cap = Math.min(Math.max(opts.maxTools || 15, 1), 40);
    const picked = scored.filter((h) => h.score >= opts.minScore).slice(0, cap);
    if (!picked.length) picked.push(scored[0]!); // top-1 保底：最佳匹配略低于门槛也给一个，避免静默零召回
    const hits = picked.map((h) => ({ name: h.name, scope: h.scope, score: Math.round(h.score * 1000) / 1000 }));
    observe('ok', undefined, hits.length);
    return hits;
  }

  /** 丢弃某源的内存索引缓存（spec 刷新/重建后调用，让下次检索读新向量）。 */
  invalidate(provider: string): void {
    this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
    for (const key of this.cache.keys()) {
      const parsed = JSON.parse(key) as [string, string, number];
      if (parsed[0] === provider) this.cache.delete(key);
    }
    for (const key of this.refreshes.keys()) {
      const parsed = JSON.parse(key) as [string, string, number];
      if (parsed[0] === provider) this.refreshes.delete(key);
    }
  }
}
