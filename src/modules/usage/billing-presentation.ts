import { billingAllowanceUsd } from './billing-ledger';
import { USD_SCALE, usdMicros } from './billing-decimal';
import type { BillingGrant, UsagePresentation } from './billing-contracts';

/** Inputs are the original grant, locked account state and DB time used by summary. */
export function usagePresentation(accountState: string, grant: BillingGrant | null, availableUsd: number | string, now: number): UsagePresentation {
  const empty: UsagePresentation = { schema: 'bailing.usage-presentation.v1', kind: 'none', state: 'unavailable', remaining: null, total: null, displayValue: null };
  if (!grant) return empty;
  const { config } = grant;
  const kind = config.mode === 'credits' ? 'credits' : 'percentage';
  const total = kind === 'credits' ? config.priceUsd * 1000 : 100;
  const unavailable = (state: UsagePresentation['state']): UsagePresentation => ({ ...empty, kind, state, total });
  if (accountState !== 'active' || grant.state !== 'active') return unavailable('suspended');
  if (grant.expiresAt !== null && now >= grant.expiresAt) return unavailable('expired');
  if (now < grant.startsAt) return unavailable('not_started');
  const available = Math.max(0, Number(availableUsd));
  const micros = available > 0 ? usdMicros(availableUsd) : 0n;
  const state = available > 0 ? 'active' : 'depleted';
  if (kind === 'credits') {
    // Decimal micro-units preserve fractional charges without binary floor errors.
    const hundredths = micros * 100_000n / USD_SCALE;
    const fraction = String(hundredths % 100n).padStart(2, '0').replace(/0+$/, '');
    const displayValue = available > 0 && hundredths === 0n ? '<0.01'
      : `${hundredths / 100n}${fraction ? `.${fraction}` : ''}`;
    return { ...empty, kind, state, total, remaining: available * 1000, displayValue };
  }
  const allowance = billingAllowanceUsd(config);
  const bounded = Math.min(available, allowance);
  const quotaMicros = usdMicros(allowance);
  const boundedMicros = micros < quotaMicros ? micros : quotaMicros;
  const wholePercent = boundedMicros * 100n / quotaMicros;
  return { ...empty, kind, state, total, remaining: Math.min(100, bounded / allowance * 100),
    displayValue: bounded > 0 && wholePercent === 0n ? '<1' : String(wholePercent) };
}
