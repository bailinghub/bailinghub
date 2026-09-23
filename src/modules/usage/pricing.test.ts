import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateReferenceCost, ReferencePricing, validatePricingBinding } from './pricing';
import { UsageRepository } from './repository';
import type { Pool } from 'mysql2/promise';
import type { PriceLine, PriceSnapshot } from './billing-contracts';

const snapshot = (lines: PriceLine[]): PriceSnapshot => ({ source: 'openrouter', currency: 'USD', modelId: 'synthetic/model', endpointId: 'synthetic-provider', fetchedAt: 1, lines });
const chat = snapshot([{ billable: 'prompt', unit: 'token', costUsd: '0.000001' }, { billable: 'completion', unit: 'token', costUsd: '0.000004' }]);

test('reference USD uses measured input and output; supplier cost is never trusted', () => {
  assert.equal(calculateReferenceCost(chat, { inputTokens: 100, outputTokens: 20, cost: 99999, costUsd: 99999, referenceCostUsd: 99999 }), '0.00018');
  assert.equal(calculateReferenceCost(chat, { prompt_tokens: 100, completion_tokens: 20 }), '0.00018');
  assert.equal(calculateReferenceCost(chat, { input_tokens: 100, output_tokens: 20 }), '0.00018');
  assert.equal(calculateReferenceCost(chat, { cost: 0 }), null);
});
test('tiny USD prices retain twelve decimals rather than truncating to free usage', () => {
  assert.equal(calculateReferenceCost(snapshot([{ billable: 'completion', unit: 'token', costUsd: '0.000000000001' }]), { outputTokens: 7 }), '0.000000000007');
  assert.equal(calculateReferenceCost(snapshot([{ billable: 'output_image', unit: 'megapixel', costUsd: '0.000000000001' }]), { outputImageCount: 1, outputPixelCount: 1 }), '0.000000000001');
});
test('explicit free prices and measured zero counts are supported; absent usage remains unknown', () => {
  const free = snapshot([{ billable: 'prompt', unit: 'token', costUsd: '0' }, { billable: 'completion', unit: 'token', costUsd: '0' }]);
  assert.equal(calculateReferenceCost(free, { inputTokens: 100, outputTokens: 20 }), '0');
  assert.equal(calculateReferenceCost(free, {}), null);
  assert.equal(calculateReferenceCost(chat, { inputTokens: 0, outputTokens: 0 }), '0');
  assert.equal(calculateReferenceCost(snapshot([]), { inputTokens: 0, outputTokens: 0 }), null);
});
test('cache hits are subtracted from full-price prompt only when separately priced', () => {
  const cached = snapshot([...chat.lines, { billable: 'input_cache_read', unit: 'token', costUsd: '0.0000001' }, { billable: 'input_cache_write', unit: 'token', costUsd: '0.000002' }]);
  assert.equal(calculateReferenceCost(cached, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, cacheWriteTokens: 10 }), '0.000154');
  assert.equal(calculateReferenceCost(chat, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 }), '0.00018');
  assert.equal(calculateReferenceCost(cached, { inputTokens: 20, outputTokens: 10, cachedInputTokens: 40, cacheWriteTokens: 0 }), null);
  assert.equal(calculateReferenceCost(cached, { inputTokens: 100, outputTokens: 20 }), null, 'Missing separately priced cache counts are unknown, not zero.');
  assert.equal(calculateReferenceCost(cached, { inputTokens: 100, outputTokens: 20, input_tokens_details: { cached_tokens: 40 }, cacheWriteTokens: 10 }), '0.000154');
});
test('image billing requires explicit matching variant; no resolution, name or count guessing', () => {
  const price = snapshot([{ billable: 'input_image', unit: 'image', costUsd: '0.003' },
    { billable: 'output_image', unit: 'image', costUsd: '0.03', variant: '1k' },
    { billable: 'output_image', unit: 'image', costUsd: '0.05', variant: '2k' }]);
  assert.equal(calculateReferenceCost(price, { inputImageCount: 0, outputImageCount: 2, outputVariant: '1k' }), '0.06');
  assert.equal(calculateReferenceCost(price, { inputImageCount: 1, outputImageCount: 2, outputVariant: '2k' }), '0.103');
  assert.equal(calculateReferenceCost(price, { outputImageCount: 1, outputVariant: '1k' }), null);
  assert.equal(calculateReferenceCost(price, { inputImageCount: 0, outputImageCount: 1, outputWidth: 1024, outputHeight: 1024 }), null);
  assert.equal(calculateReferenceCost(price, { inputImageCount: 0, outputImageCount: 1, outputVariant: '4k' }), null);
  const ambiguous = snapshot([...price.lines, { billable: 'output_image', unit: 'image', costUsd: '0.01' }]);
  assert.equal(calculateReferenceCost(ambiguous, { inputImageCount: 0, outputImageCount: 1, outputVariant: '1k' }), null);
});
test('image tokens and total measured pixel counts have distinct units', () => {
  assert.equal(calculateReferenceCost(snapshot([{ billable: 'output_image', unit: 'token', costUsd: '0.000001' }]), { outputImageCount: 1, outputImageTokens: 1200 }), '0.0012');
  assert.equal(calculateReferenceCost(snapshot([{ billable: 'output_image', unit: 'token', costUsd: '0.000001' }]), { outputImageCount: 1 }), null);
  assert.equal(calculateReferenceCost(snapshot([{ billable: 'output_image', unit: 'megapixel', costUsd: '0.01' }]), { outputImageCount: 2, outputPixelCount: 2_500_000 }), '0.025');
});
test('unsupported or malformed metering never produces a fabricated charge, including zero-count cases', () => {
  for (const raw of [{inputTokens: -1,outputTokens: 0}, {inputTokens: 1.1,outputTokens: 0}, {inputTokens: NaN,outputTokens: 0}, {inputTokens: '1',outputTokens: 0}]) assert.equal(calculateReferenceCost(chat, raw), null);
  assert.equal(calculateReferenceCost(snapshot([{ billable: 'unknown_metric', unit: 'token', costUsd: '1' }]), { inputTokens: 1 }), null);
  assert.equal(calculateReferenceCost(snapshot([{ billable: 'prompt', unit: 'image', costUsd: '1' }]), { inputTokens: 1 }), null);
  assert.equal(calculateReferenceCost(snapshot([{ billable: 'prompt', unit: 'token', costUsd: '-1' }]), { inputTokens: 0 }), null);
  assert.equal(calculateReferenceCost(snapshot([{ billable: 'prompt', unit: 'second', costUsd: '1' }]), { inputTokens: 0 }), null);
});
test('request fees require a measured request count and are added once', () => {
  const price = snapshot([...chat.lines, { billable: 'request', unit: 'request', costUsd: '0.01' }]);
  assert.equal(calculateReferenceCost(price, { inputTokens: 100, outputTokens: 20, requestCount: 1 }), '0.01018');
  assert.equal(calculateReferenceCost(price, { inputTokens: 100, outputTokens: 20 }), null);
});

/** Synthetic persistence and transport only: no real endpoint, account or provider key. */
function cacheFixture() {
  const saved = new Map<string, any>();
  const pool = { async query(sql: string, parameters: any[]) {
    if (sql.startsWith('SELECT snapshot_json')) { const v = saved.get(parameters[0]); return [v ? [{ snapshot_json: structuredClone(v) }] : []]; }
    if (sql.startsWith('INSERT INTO bz_usage_price_snapshots')) { saved.set(parameters[0], JSON.parse(parameters[1])); return [{}]; }
    throw new Error('Unexpected synthetic query');
  } } as unknown as Pool;
  let calls = 0, status = 200;
  let value: unknown = { data: { endpoints: [{ tag: 'synthetic-provider', provider_name: 'Synthetic', pricing: { prompt: '0.000001', completion: '0.000004' } }] } };
  const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
    calls++; assert.equal(options?.redirect, 'error'); assert(String(url).startsWith('https://openrouter.ai/api/v1/'));
    return new Response(JSON.stringify(value), { status, headers: {'content-type': 'application/json'} });
  }) as typeof fetch;
  const repository = new UsageRepository(() => pool), pricing = new ReferencePricing(repository, fetcher);
  return { pricing, saved, calls: () => calls, set(v: unknown, s = 200) { value = v; status = s; } };
}
const binding = {source:'openrouter' as const,kind:'chat' as const,modelId:'synthetic/model',endpointId:'synthetic-provider'};
test('binding is explicit and rejects arbitrary remote URLs and path traversal', () => {
  validatePricingBinding(binding);
  for (const value of [{...binding,modelId:'../secret'}, {...binding,source:'custom'}, {...binding,endpointId:''}, {...binding,url:'https://invalid.example'}]) assert.throws(() => validatePricingBinding(value));
});
test('reference snapshot requires synchronized selected endpoint and never adds a fetch before admission', async () => {
  const h = cacheFixture();
  await assert.rejects(h.pricing.snapshot(binding), { code:'USAGE_PRICE_UNAVAILABLE' }); assert.equal(h.calls(), 0);
  await h.pricing.catalog('chat', binding.modelId); assert.equal(h.calls(), 1);
  const original = await h.pricing.snapshot(binding); assert.equal(h.calls(), 1); assert.equal(original.lines[0]!.costUsd, '0.000001');
  original.lines[0]!.costUsd = '999'; assert.equal((await h.pricing.snapshot(binding)).lines[0]!.costUsd, '0.000001');
  await assert.rejects(h.pricing.snapshot({...binding,endpointId:'other-provider'}), {code:'USAGE_PRICE_UNAVAILABLE'});
  await h.pricing.catalog('chat',binding.modelId); assert.equal(h.calls(),1);
});
test('catalog outage keeps the last verified price; first-time outage never invents zero price', async () => {
  const h=cacheFixture(); await h.pricing.catalog('chat',binding.modelId);
  h.set({error:'synthetic'},503);
  const stale=await h.pricing.catalog('chat',binding.modelId,true); assert.equal(stale.stale,true);
  assert.equal((await h.pricing.snapshot(binding)).lines[0]!.costUsd,'0.000001');
  const first=cacheFixture(); first.set({},503);
  await assert.rejects(first.pricing.catalog('chat',binding.modelId), {code:'USAGE_PRICE_UNAVAILABLE'});
});
test('ambiguous endpoint and unknown priced dimensions cannot silently select another quote', async () => {
  const h=cacheFixture(); await h.pricing.catalog('chat',binding.modelId);
  assert.equal((await h.pricing.snapshot(binding)).lines[0]!.costUsd,'0.000001');
  h.set({data:{endpoints:[{tag:'synthetic-provider',pricing:{prompt:'0.1',completion:'0.2',unknown_dimension:'1'}}]}});
  const result=await h.pricing.catalog('chat',binding.modelId,true); assert.equal(result.items[0].unavailable,true);
  await assert.rejects(h.pricing.snapshot(binding),{code:'USAGE_PRICE_UNSUPPORTED'});
  h.set({data:{endpoints:[{tag:'synthetic-provider',pricing:{prompt:'0.1',completion:'0.2'}},{tag:'synthetic-provider',pricing:{prompt:'0.5',completion:'0.2'}}]}});
  assert.equal((await h.pricing.catalog('chat',binding.modelId,true)).items.length,0);
});

test('tier selects the highest measured prompt threshold inclusively, not incremental bands or uncached tokens', () => {
  const tiered: PriceSnapshot = { ...chat, tiers: [
    { minPromptTokens: 500000, lines: [{billable:'prompt',unit:'token',costUsd:'0.000004'},{billable:'completion',unit:'token',costUsd:'0.000016'}] },
    { minPromptTokens: 272000, lines: [{billable:'prompt',unit:'token',costUsd:'0.000002'},{billable:'completion',unit:'token',costUsd:'0.000008'}] },
  ] };
  assert.equal(calculateReferenceCost(tiered,{inputTokens:271999,outputTokens:10}),'0.272039');
  assert.equal(calculateReferenceCost(tiered,{inputTokens:272000,outputTokens:10}),'0.54408');
  assert.equal(calculateReferenceCost(tiered,{inputTokens:500000,outputTokens:10}),'2.00016');
  assert.equal(calculateReferenceCost(tiered,{outputTokens:10}),null);
  const cached: PriceSnapshot = { ...chat, tiers:[{minPromptTokens:272000,lines:[
    {billable:'prompt',unit:'token',costUsd:'0.000002'}, {billable:'completion',unit:'token',costUsd:'0.000008'},
    {billable:'input_cache_read',unit:'token',costUsd:'0.0000002'}, {billable:'input_cache_write',unit:'token',costUsd:'0.000004'},
  ]}] };
  assert.equal(calculateReferenceCost(cached,{inputTokens:300000,outputTokens:10,cachedInputTokens:200000,cacheWriteTokens:0}),'0.24008');
  assert.equal(calculateReferenceCost(cached,{inputTokens:300000,outputTokens:10,cachedInputTokens:200000}),null);
  assert.equal(calculateReferenceCost({...tiered,tiers:[tiered.tiers![0]!,tiered.tiers![0]!]}, {inputTokens:1,outputTokens:0}),null);
});

test('web search is a separately measured request fee: missing is unknown, explicit zero is no fee', () => {
  const price=snapshot([...chat.lines,{billable:'web_search',unit:'request',costUsd:'0.01'}]);
  assert.equal(calculateReferenceCost(price,{inputTokens:100,outputTokens:20}),null);
  assert.equal(calculateReferenceCost(price,{inputTokens:100,outputTokens:20,webSearchCount:0}),'0.00018');
  assert.equal(calculateReferenceCost(price,{inputTokens:100,outputTokens:20,webSearchCount:2}),'0.02018');
  assert.equal(calculateReferenceCost(price,{inputTokens:100,outputTokens:20,webSearchCount:'0'}),null);
});

test('catalog normalizes tier overrides into frozen complete quotes retaining base request fees', async () => {
  const h=cacheFixture();
  h.set({data:{endpoints:[{tag:'synthetic-provider',pricing:{prompt:'0.000001',completion:'0.000004',input_cache_read:'0.0000001',input_cache_write:'0.000002',web_search:'0.01',
    overrides:[{min_prompt_tokens:272000,prompt:'0.000002',completion:'0.000008',input_cache_read:'0.0000002',input_cache_write:'0.000004'}]}}]}});
  const catalog=await h.pricing.catalog('chat',binding.modelId); assert.equal(catalog.items[0].unavailable,undefined);
  const price=await h.pricing.snapshot(binding);
  assert.equal(price.tiers?.[0]?.minPromptTokens,272000); assert.equal(price.tiers?.[0]?.lines.length,5);
  assert.equal(price.tiers?.[0]?.lines.find(line=>line.billable==='web_search')?.costUsd,'0.01');
  assert.equal(calculateReferenceCost(price,{inputTokens:300000,outputTokens:10,cachedInputTokens:200000,cacheWriteTokens:0,webSearchCount:0}),'0.24008');
  assert.equal(calculateReferenceCost(price,{inputTokens:300000,outputTokens:10,cachedInputTokens:200000,cacheWriteTokens:0}),null);
  h.set({data:{endpoints:[{tag:'synthetic-provider',pricing:{prompt:'1',completion:'1',overrides:[{min_prompt_tokens:1,min_output_tokens:1,prompt:'2'}]}}]}});
  const bad=await h.pricing.catalog('chat',binding.modelId,true); assert.equal(bad.items[0].unavailable,true);
  await assert.rejects(h.pricing.snapshot(binding),{code:'USAGE_PRICE_UNSUPPORTED'});
});

test('admission snapshot rejects invalid tier thresholds and invalid future-tier units before any dispatch', async () => {
  const { tokenBillingRate } = await import('./billing-ledger');
  const price: PriceSnapshot = {...chat,tiers:[{minPromptTokens:272000,lines:chat.lines}]};
  assert.deepEqual(tokenBillingRate('synthetic-plan',1,1.5,price).price,price);
  assert.throws(()=>tokenBillingRate('synthetic-plan',1,1.5,{...price,tiers:[price.tiers![0]!,price.tiers![0]!]}), /unique/);
  assert.throws(()=>tokenBillingRate('synthetic-plan',1,1.5,{...price,tiers:[{minPromptTokens:0,lines:chat.lines}]}), /positive/);
  assert.throws(()=>tokenBillingRate('synthetic-plan',1,1.5,{...price,tiers:[{minPromptTokens:1,lines:[{billable:'prompt',unit:'image',costUsd:'1'}]}]}), /Invalid/);
});


test('readiness distinguishes unbound, unsynchronized, unsupported and ready without provider traffic', async () => {
  const h = cacheFixture();
  assert.equal((await h.pricing.inspect(undefined)).availability.code, 'USAGE_PRICE_NOT_CONFIGURED');
  assert.equal((await h.pricing.inspect(binding)).availability.code, 'USAGE_PRICE_UNAVAILABLE');
  assert.equal(h.calls(), 0);
  await h.pricing.catalog('chat', binding.modelId);
  assert.deepEqual((await h.pricing.inspect(binding)).availability, {state:'ready',code:null,message:null});
  assert.equal(h.calls(), 1);
  h.set({data:{endpoints:[{tag:binding.endpointId,pricing:{prompt:'1',completion:'2',unsupported_meter:'3'}}]}});
  await h.pricing.catalog('chat', binding.modelId, true);
  assert.equal((await h.pricing.inspect(binding)).availability.code, 'USAGE_PRICE_UNSUPPORTED');
  assert.equal(h.calls(), 2);
});
