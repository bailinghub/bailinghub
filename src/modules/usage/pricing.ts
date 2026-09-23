import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { UsageError, usageAssert } from './errors';
import { assertKnownFields } from './validation';
import { usdMicros, usdDecimal } from './billing-decimal';
import type { PriceLine, PriceSnapshot, PriceTier } from './billing-contracts';
import type { UsageRepository } from './repository';

export interface PricingBinding { source: 'openrouter'; kind: 'chat' | 'image'; modelId: string; endpointId: string }
export interface PriceAvailability {
  state: 'ready' | 'unavailable'; code: string | null; message: string | null;
}
export function validatePricingBinding(value: unknown): asserts value is PricingBinding {
  assertKnownFields(value, ['source','kind','modelId','endpointId'], 'pricing');
  const p = value as PricingBinding;
  usageAssert(p?.source === 'openrouter' && ['chat','image'].includes(p.kind)
    && typeof p.modelId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,190}$/.test(p.modelId)
    && !p.modelId.includes('..') && typeof p.endpointId === 'string' && p.endpointId.length > 0 && p.endpointId.length <= 191,
  'USAGE_INVALID_INPUT', '请选择明确的参考模型和价格端点。', 400);
}
const finiteCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function numericPrice(value: unknown): string {
  usageAssert(typeof value === 'string' || typeof value === 'number', 'USAGE_PRICE_UNAVAILABLE', '参考价格缺少有效单价。', 503);
  return usdDecimal(usdMicros(value));
}
function imageLines(value: unknown): PriceLine[] {
  usageAssert(Array.isArray(value) && value.length > 0 && value.length <= 64, 'USAGE_PRICE_UNAVAILABLE', '参考价格缺少计费项。', 503);
  return value.map(line => {
    usageAssert(line && ['input_image','output_image','input_reference'].includes(line.billable)
      && ['image','megapixel','token'].includes(line.unit) && (line.variant === undefined || typeof line.variant === 'string'),
    'USAGE_PRICE_UNSUPPORTED', '此价格规则尚无计量映射，不能按免费处理。', 503);
    return { billable: line.billable, unit: line.unit, costUsd: numericPrice(line.cost_usd), ...(line.variant ? { variant: line.variant.toLowerCase() } : {}) };
  });
}
function chatLines(p: Record<string, unknown>): PriceLine[] {
  const fields = ['prompt','completion','input_cache_read','input_cache_write'];
  usageAssert(p && p.prompt !== undefined && p.completion !== undefined, 'USAGE_PRICE_UNAVAILABLE', '缺少输入或输出参考单价。', 503);
  for (const [key, value] of Object.entries(p)) {
    if (![...fields,'discount','request','web_search'].includes(key) && Number(value) !== 0)
      throw new UsageError('USAGE_PRICE_UNSUPPORTED', `参考价格包含尚未适配的计费项：${key}`, 503);
  }
  return [...fields.filter(k => p[k] !== undefined).map(k => ({ billable: k, unit: 'token' as const, costUsd: numericPrice(p[k]) })),
    ...['request','web_search'].filter(k => p[k] !== undefined && Number(p[k]) !== 0).map(k => ({ billable: k, unit: 'request' as const, costUsd: numericPrice(p[k]) }))];
}
/** Persist complete tier quotes so later catalog changes cannot reinterpret a request. */
function chatPricing(value: Record<string, unknown>): Pick<PriceSnapshot, 'lines' | 'tiers'> {
  usageAssert(value && typeof value === 'object' && !Array.isArray(value), 'USAGE_PRICE_UNAVAILABLE', '缺少参考价格。', 503);
  const { overrides, ...base } = value;
  const lines = chatLines(base);
  if (overrides === undefined) return { lines };
  usageAssert(Array.isArray(overrides) && overrides.length <= 64, 'USAGE_PRICE_UNSUPPORTED', '阶梯报价格式不支持。', 503);
  const seen = new Set<number>();
  const tiers: PriceTier[] = overrides.map(override => {
    usageAssert(override && typeof override === 'object' && !Array.isArray(override), 'USAGE_PRICE_UNSUPPORTED', '阶梯报价格式不支持。', 503);
    const { min_prompt_tokens, ...rates } = override;
    usageAssert(finiteCount(min_prompt_tokens) && min_prompt_tokens > 0 && !seen.has(min_prompt_tokens), 'USAGE_PRICE_UNSUPPORTED', '阶梯报价门槛必须明确且唯一。', 503);
    usageAssert(Object.keys(rates).every(key => ['prompt','completion','input_cache_read','input_cache_write','request','web_search','discount'].includes(key)),
      'USAGE_PRICE_UNSUPPORTED', '阶梯报价含未适配的条件或收费项。', 503);
    seen.add(min_prompt_tokens);
    return { minPromptTokens: min_prompt_tokens, lines: chatLines({ ...base, ...rates }) };
  }).sort((a,b) => a.minPromptTokens - b.minPromptTokens);
  return { lines, ...(tiers.length ? { tiers } : {}) };
}

/** Reference pricing is independent of the actual provider bill. Unknown usage never means zero. */
export function calculateReferenceCost(snapshot: PriceSnapshot, raw: Record<string, unknown>): string | null {
  try {
    if (!snapshot.lines.length) return null;
    let selectedLines = snapshot.lines;
    if (snapshot.tiers !== undefined) {
      if (!Array.isArray(snapshot.tiers) || snapshot.tiers.length > 64) return null;
      const input = raw.inputTokens ?? raw.prompt_tokens ?? raw.input_tokens;
      if (!finiteCount(input)) return null;
      let selectedThreshold = -1;
      const seen = new Set<number>();
      for (const tier of snapshot.tiers) {
        if (!finiteCount(tier.minPromptTokens) || tier.minPromptTokens <= 0 || seen.has(tier.minPromptTokens)
          || !Array.isArray(tier.lines) || !tier.lines.length) return null;
        seen.add(tier.minPromptTokens);
        if (input >= tier.minPromptTokens && tier.minPromptTokens > selectedThreshold) {
          selectedLines = tier.lines; selectedThreshold = tier.minPromptTokens;
        }
      }
    }
    let total = 0n;
    const groups = new Map<string, PriceLine[]>();
    const tokenMetrics = new Set(['prompt','completion','input_cache_read','input_cache_write']);
    const imageMetrics = new Set(['input_image','output_image','input_reference']);
    for (const line of selectedLines) {
      // Validate even when the measured count is zero. Unknown dimensions and
      // corrupt quotes must never silently become a valid free-price record.
      const validUnit = tokenMetrics.has(line.billable) ? line.unit === 'token'
        : imageMetrics.has(line.billable) ? ['image','megapixel','token'].includes(line.unit)
          : ['request','web_search'].includes(line.billable) && line.unit === 'request';
      if (!validUnit) return null;
      usdMicros(line.costUsd);
      const group = groups.get(line.billable) ?? []; group.push(line); groups.set(line.billable, group);
    }
    const cache = (raw.prompt_tokens_details ?? raw.input_tokens_details) as Record<string,unknown> | undefined;
    const cached = groups.has('input_cache_read') ? raw.cachedInputTokens ?? cache?.cached_tokens ?? raw.prompt_cache_hit_tokens : 0;
    const written = groups.has('input_cache_write') ? raw.cacheWriteTokens ?? raw.cache_creation_input_tokens : 0;
    // The reference quote distinguishes these counts, so missing evidence
    // cannot be treated as zero or billed at the undiscounted prompt price.
    if (!finiteCount(cached) || !finiteCount(written)) return null;
    for (const [billable, lines] of groups) {
      let count: unknown, variant: unknown;
      const input = raw.inputTokens ?? raw.prompt_tokens ?? raw.input_tokens;
      const output = raw.outputTokens ?? raw.completion_tokens ?? raw.output_tokens;
      switch (billable) {
        case 'prompt': {
          if (!finiteCount(input)) return null;
          count = input - (groups.has('input_cache_read') ? cached : 0) - (groups.has('input_cache_write') ? written : 0); break;
        }
        case 'completion': count = output; break;
        case 'input_cache_read': count = cached; break;
        case 'input_cache_write': count = written; break;
        case 'request': count = raw.requestCount; break;
        case 'web_search': count = raw.webSearchCount; break;
        case 'input_image': case 'input_reference': count = raw.inputImageCount; variant = raw.inputVariant; break;
        case 'output_image': count = raw.outputImageCount; variant = raw.outputVariant; break;
        default: return null;
      }
      if (!finiteCount(count)) return null;
      if (count === 0) continue;
      const matching = lines.filter(l => !l.variant || l.variant === variant);
      if (matching.length !== 1) return null;
      const line = matching[0]!;
      if ((billable.endsWith('image') || billable === 'input_reference') && line.unit === 'token') {
        const tokens = billable === 'output_image' ? raw.outputImageTokens : raw.inputImageTokens;
        if (!finiteCount(tokens)) return null; count = tokens;
      }
      if (!finiteCount(count)) return null;
      let multiplier = BigInt(count), divisor = 1n;
      if (line.unit === 'megapixel') {
        const pixels = billable === 'output_image' ? raw.outputPixelCount : raw.inputPixelCount;
        if (!finiteCount(pixels)) return null;
        multiplier = BigInt(pixels); divisor = 1_000_000n;
      }
      total += (usdMicros(line.costUsd) * multiplier + divisor - 1n) / divisor;
    }
    return usdDecimal(total);
  } catch { return null; }
}

const TTL = 6 * 60 * 60 * 1000;
const MAX_RESPONSE = 8 * 1024 * 1024;
type Catalog = { items: any[]; fetchedAt: number; stale?: boolean };
export class ReferencePricing {
  private flights = new Map<string, Promise<Catalog>>();
  constructor(private repository: UsageRepository, private fetcher: typeof fetch = fetch) {}
  private async get(key: string): Promise<Catalog | null> {
    const [rows] = await this.repository.getPool().query<RowDataPacket[]>('SELECT snapshot_json FROM bz_usage_price_snapshots WHERE cache_key=?', [key]);
    if (!rows[0]) return null;
    return typeof rows[0].snapshot_json === 'string' ? JSON.parse(rows[0].snapshot_json) : rows[0].snapshot_json;
  }
  private async save(key: string, data: Catalog) {
    await this.repository.getPool().query('INSERT INTO bz_usage_price_snapshots(cache_key,snapshot_json,fetched_at) VALUES(?,?,?) ON DUPLICATE KEY UPDATE snapshot_json=VALUES(snapshot_json),fetched_at=VALUES(fetched_at)', [key, JSON.stringify(data),data.fetchedAt]);
  }
  private key(kind: string, model?: string) { return createHash('sha256').update(`${kind}:${model ?? 'catalog'}`).digest('hex'); }
  private async fetchJson(path: string): Promise<any> {
    const response = await this.fetcher(`https://openrouter.ai/api/v1/${path}`, { redirect:'error', signal:AbortSignal.timeout(10000), headers:{accept:'application/json'} });
    usageAssert(response.ok, 'USAGE_PRICE_UNAVAILABLE', '参考价格目录暂不可用。', 503);
    let bytes = 0; const chunks: Uint8Array[] = [];
    if (!response.body) throw new UsageError('USAGE_PRICE_UNAVAILABLE','参考目录返回空内容。',503);
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > MAX_RESPONSE) { await response.body.cancel().catch(()=>{}); throw new UsageError('USAGE_PRICE_UNAVAILABLE','参考目录响应过大。',503); } chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private async refresh(kind: 'chat'|'image', modelId?: string): Promise<Catalog> {
    const key = this.key(kind,modelId), pending = this.flights.get(key); if (pending) return pending;
    const job = (async () => {
      const prefix = kind === 'image' ? 'images/models' : 'models';
      const encoded = modelId?.split('/').map(encodeURIComponent).join('/');
      const value = await this.fetchJson(modelId ? `${prefix}/${encoded}/endpoints` : prefix);
      const fetchedAt = Date.now(); let items: any[];
      if (!modelId) {
        usageAssert(Array.isArray(value.data), 'USAGE_PRICE_UNAVAILABLE','参考模型目录格式异常。',503);
        items = value.data.filter((x:any) => typeof x.id === 'string' && (kind === 'image' || x.architecture?.output_modalities?.includes('text'))).map((x:any)=>({id:x.id,label:x.name||x.id,kind}));
      } else {
        const endpoints = kind === 'image' ? value.endpoints : value.data?.endpoints;
        usageAssert(Array.isArray(endpoints), 'USAGE_PRICE_UNAVAILABLE','参考端点目录格式异常。',503);
        items = endpoints.map((x:any) => {
          const id = kind === 'image' ? x.provider_tag ?? x.provider_slug : x.tag;
          if (typeof id !== 'string' || !id) return null;
          try { const quote = kind === 'image' ? { lines: imageLines(x.pricing) } : chatPricing(x.pricing);
            return {id,label:x.provider_name||id,pricing:{source:'openrouter',modelId,endpointId:id,currency:'USD',fetchedAt,...quote} satisfies PriceSnapshot};
          } catch { return {id,label:x.provider_name||id,unavailable:true,reason:'USAGE_PRICE_UNSUPPORTED'}; }
        }).filter(Boolean);
        // A duplicate endpoint ID cannot silently pick a different price record.
        items = items.filter((x:any) => items.filter((y:any)=>y.id===x.id).length===1);
      }
      const result = {items,fetchedAt}; await this.save(key,result); return result;
    })();
    this.flights.set(key,job); try {return await job;} finally {this.flights.delete(key);}
  }
  async catalog(kind:'chat'|'image', modelId?: string, force=false): Promise<Catalog> {
    if (modelId) validatePricingBinding({source:'openrouter',kind,modelId,endpointId:'lookup'});
    const cached=await this.get(this.key(kind,modelId));
    if (cached && !force) {
      const stale = Date.now()-cached.fetchedAt > TTL;
      if (stale) void this.refresh(kind,modelId).catch(()=>{});
      return {...cached,stale};
    }
    try {return {...await this.refresh(kind,modelId),stale:false};}
    catch(error){if(cached)return {...cached,stale:true};throw error;}
  }
  /** Same cached quote check for the console, discovery and dispatch. No paid call or catalog round-trip. */
  async inspect(binding: PricingBinding | undefined): Promise<{ availability: PriceAvailability; price?: PriceSnapshot }> {
    const unavailable = (code: string, message: string) => ({ availability: {state: 'unavailable' as const, code, message} });
    if (!binding) return unavailable('USAGE_PRICE_NOT_CONFIGURED', '尚未绑定参考模型和价格端点，请配置参考价格。');
    try { validatePricingBinding(binding); }
    catch { return unavailable('USAGE_PRICE_NOT_CONFIGURED', '参考价格绑定无效，请重新配置。'); }
    const cached = await this.get(this.key(binding.kind,binding.modelId));
    const endpoint = cached?.items.find(x=>x.id===binding.endpointId);
    if (!cached) return unavailable('USAGE_PRICE_UNAVAILABLE', '参考价格尚未同步，请在模型服务中同步价格。');
    if (!endpoint) return unavailable('USAGE_PRICE_UNAVAILABLE', '参考端点已不在目录中，请重新选择端点并同步价格。');
    if (endpoint.unavailable) return unavailable('USAGE_PRICE_UNSUPPORTED', '参考端点的计量规则暂不支持，请选择受支持的参考端点。');
    if (!endpoint.pricing) return unavailable('USAGE_PRICE_UNAVAILABLE', '参考端点缺少有效报价，请同步价格或重新配置。');
    if (Date.now()-cached!.fetchedAt > TTL) void this.refresh(binding.kind,binding.modelId).catch(()=>{});
    return {availability:{state:'ready',code:null,message:null},price:structuredClone(endpoint.pricing)};
  }
  async snapshot(binding: PricingBinding | undefined): Promise<PriceSnapshot> {
    const result = await this.inspect(binding);
    usageAssert(result.price, result.availability.code ?? 'USAGE_PRICE_UNAVAILABLE',result.availability.message ?? '参考价格暂不可用。',503);
    return result.price;
  }
}
const instances=new WeakMap<UsageRepository,ReferencePricing>();
export function referencePricing(repository:UsageRepository) {let p=instances.get(repository);if(!p){p=new ReferencePricing(repository);instances.set(repository,p);}return p;}
