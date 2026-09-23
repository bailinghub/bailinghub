import { usageAssert } from './errors';
import { assertKnownFields, integer } from './validation';
import { periodBounds } from './period';
import { usdMicros, USD_SCALE } from './billing-decimal';
import type { BillingAllowanceConfig, BillingRate, BillingGrant, PriceSnapshot, BillingPlanConfig, TokenUsage } from './billing-contracts';

export function billingKey(value: unknown, name = 'id', max = 191): string {
  usageAssert(typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value),
    'USAGE_INVALID_INPUT', `Invalid ${name}.`, 400);
  return value;
}
export function validateBillingPlan(value: unknown): BillingPlanConfig {
  assertKnownFields(value, ['mode','serviceIds','priceUsd','periodAllowanceUsd','multiplier','periodUnit','duration'], 'USD plan');
  const c = value as BillingPlanConfig;
  usageAssert(Array.isArray(c.serviceIds) && c.serviceIds.length <= 64, 'USAGE_INVALID_INPUT', 'Model services must be an explicit list.', 400);
  c.serviceIds.forEach(id => billingKey(id, 'serviceId'));
  usageAssert(new Set(c.serviceIds).size === c.serviceIds.length, 'USAGE_INVALID_INPUT', 'Model services must be unique.', 400);
  return { ...billingAllowance(c), serviceIds: [...c.serviceIds], multiplier: validateMultiplier(c.multiplier) };
}
/** Project immutable allowance terms; model selection belongs only to the current plan. */
export function billingAllowance(value: BillingAllowanceConfig): BillingAllowanceConfig {
  const c = value;
  usageAssert(['credits','periodic'].includes(c.mode), 'USAGE_INVALID_INPUT', 'Choose an allowance pack or a periodic plan.', 400);
  usageAssert(typeof c.priceUsd === 'number' && c.priceUsd > 0 && c.priceUsd <= 1_000_000_000, 'USAGE_INVALID_INPUT', 'priceUsd must be positive and within range.', 400);
  usdMicros(c.priceUsd, 'priceUsd');
  if (c.mode === 'periodic') {
    usageAssert(typeof c.periodAllowanceUsd === 'number' && c.periodAllowanceUsd > 0 && c.periodAllowanceUsd <= 1_000_000_000,
      'USAGE_INVALID_INPUT', 'periodAllowanceUsd must be positive and within range for periodic plans.', 400);
    usdMicros(c.periodAllowanceUsd, 'periodAllowanceUsd');
  } else usageAssert(c.periodAllowanceUsd === undefined, 'USAGE_INVALID_INPUT', 'Credits plans do not accept periodAllowanceUsd.', 400);
  usageAssert(c.mode === 'periodic' ? ['day','week','month'].includes(c.periodUnit ?? '') : c.periodUnit === undefined,
    'USAGE_INVALID_INPUT', 'Periodic plans require one reset schedule; allowance packs have no reset.', 400);
  assertKnownFields(c.duration, ['unit','count'], 'duration');
  usageAssert(['day','month','forever'].includes(c.duration.unit), 'USAGE_INVALID_INPUT', 'Unsupported duration.', 400);
  usageAssert(c.duration.unit !== 'forever' || c.mode === 'credits', 'USAGE_INVALID_INPUT', 'Periodic subscriptions need an expiry.', 400);
  integer(c.duration.count, 'duration.count', c.duration.unit === 'forever' ? 0 : 1, 1200);
  return { mode: c.mode, priceUsd: c.priceUsd, duration: structuredClone(c.duration),
    ...(c.mode === 'periodic' ? { periodAllowanceUsd: c.periodAllowanceUsd } : {}),
    ...(c.periodUnit === undefined ? {} : { periodUnit: c.periodUnit }) };
}
/** Effective allowance from explicit terms; never infer periodic allowance from sale price. */
export function billingAllowanceUsd(config: BillingAllowanceConfig): number {
  const terms = billingAllowance(config);
  return terms.mode === 'periodic' ? terms.periodAllowanceUsd! : terms.priceUsd;
}
/** Calendar months retain the original UTC day, clamping only in shorter months. */
export function billingExpiry(startsAt: number, duration: BillingAllowanceConfig['duration']): number | null {
  integer(startsAt, 'startsAt', 0, 8_000_000_000_000_000);
  if (duration.unit === 'forever') return null;
  if (duration.unit === 'day') return integer(startsAt + duration.count * 86_400_000, 'expiresAt');
  const start = new Date(startsAt), out = new Date(startsAt);
  out.setUTCDate(1); out.setUTCMonth(out.getUTCMonth() + duration.count);
  out.setUTCDate(Math.min(start.getUTCDate(), new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate()));
  return integer(out.getTime(), 'expiresAt');
}
export function billingPeriod(grant: Pick<BillingGrant, 'startsAt' | 'expiresAt' | 'config'>, now: number): { start: number; end: number | null } | null {
  if (now < grant.startsAt || (grant.expiresAt !== null && now >= grant.expiresAt)) return null;
  if (grant.config.mode === 'credits') return { start: grant.startsAt, end: grant.expiresAt };
  const p = periodBounds({ unit: grant.config.periodUnit!, anchor: grant.startsAt, timezone: 'UTC' }, now)!;
  return { start: p.start, end: Math.min(p.end, grant.expiresAt ?? p.end) };
}
export function tokenUsage(value: { inputTokens: number; outputTokens: number }): TokenUsage {
  const inputTokens = integer(value.inputTokens, 'inputTokens'), outputTokens = integer(value.outputTokens, 'outputTokens');
  return { inputTokens, outputTokens, totalTokens: integer(inputTokens + outputTokens, 'totalTokens') };
}

export function validateMultiplier(value: unknown): number {
  usageAssert(typeof value === 'number' && value >= 0.000001 && value <= 1000,
    'USAGE_INVALID_INPUT', 'multiplier must be between 0.000001 and 1000.', 400);
  usdMicros(value, 'multiplier'); return value;
}
export function tokenBillingRate(planId: string, planRevision: number, multiplier: number, price: PriceSnapshot): BillingRate {
  billingKey(planId, 'planId'); integer(planRevision, 'planRevision', 1);
  usageAssert(price?.source === 'openrouter' && price.currency === 'USD' && typeof price.modelId === 'string' && price.modelId.length > 0
    && typeof price.endpointId === 'string' && price.endpointId.length > 0 && Array.isArray(price.lines) && price.lines.length > 0,
    'METERING_UNAVAILABLE', 'A verified reference price snapshot is required.', 503);
  integer(price.fetchedAt, 'fetchedAt');
  const lineSets = [price.lines];
  if (price.tiers !== undefined) {
    usageAssert(Array.isArray(price.tiers) && price.tiers.length <= 64, 'METERING_UNAVAILABLE', 'Invalid reference price tiers.', 503);
    const seen = new Set<number>();
    for (const tier of price.tiers) {
      usageAssert(Number.isSafeInteger(tier.minPromptTokens) && tier.minPromptTokens > 0 && !seen.has(tier.minPromptTokens),
        'METERING_UNAVAILABLE', 'Reference price thresholds must be unique positive token counts.', 503);
      seen.add(tier.minPromptTokens); lineSets.push(tier.lines);
    }
  }
  for (const lines of lineSets) {
    usageAssert(Array.isArray(lines) && lines.length > 0 && lines.length <= 64, 'METERING_UNAVAILABLE', 'Invalid reference price lines.', 503);
    for (const line of lines) {
      const validUnit = ['prompt','completion','input_cache_read','input_cache_write'].includes(line.billable) ? line.unit === 'token'
        : ['input_image','output_image','input_reference'].includes(line.billable) ? ['token','image','megapixel'].includes(line.unit)
          : ['request','web_search'].includes(line.billable) && line.unit === 'request';
      usageAssert(validUnit, 'METERING_UNAVAILABLE', 'Invalid reference price line.', 503);
      usdMicros(line.costUsd, 'costUsd');
    }
  }
  return { planId, planRevision, multiplier: validateMultiplier(multiplier), price: structuredClone(price) };
}
/** Round a positive sub-unit charge up, never silently turn it into free usage. */
export function billedUsdMicros(referenceCostUsd: string, multiplier: number): bigint {
  const product = usdMicros(referenceCostUsd) * usdMicros(validateMultiplier(multiplier));
  return (product + USD_SCALE - 1n) / USD_SCALE;
}
