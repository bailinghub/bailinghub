import test from 'node:test';
import assert from 'node:assert/strict';
import { billingAllowance, billingExpiry, billingPeriod, tokenUsage, validateBillingPlan } from './billing-ledger';
import type { BillingPlanConfig } from './billing-contracts';
const config: BillingPlanConfig = { mode: 'periodic', serviceIds: ['synthetic-model'], priceUsd: 1000, periodAllowanceUsd: 1000, periodUnit: 'month', duration: { unit: 'month', count: 3 }, multiplier: 1.5 };
test('Token plans reject turn limits and invalid units; Credits changes display only', () => {
  assert.deepEqual(validateBillingPlan(config), config);
  assert.throws(() => validateBillingPlan({ ...config, maxOperationsPerTurn: 8 }), /unsupported fields/);
  assert.throws(() => validateBillingPlan({ ...config, priceUsd: 0 }), /range/);
  assert.throws(() => validateBillingPlan({ ...config, duration: { unit: 'forever', count: 0 } }), /expiry/);
  assert.throws(() => validateBillingPlan({ ...config, serviceIds: ['one','one'] }), /unique/);
  assert.throws(() => validateBillingPlan({ ...config, multiplier: 0 }), /between/);
  assert.deepEqual(tokenUsage({ inputTokens: 60, outputTokens: 40 }), { inputTokens: 60, outputTokens: 40, totalTokens: 100 });
  assert.throws(() => tokenUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }), /range/);
  assert.throws(() => validateBillingPlan({ ...config, displayUnit: 'credits' }), /unsupported fields/);
  assert.throws(() => validateBillingPlan({ ...config, displayUnit: 'tokens' }), /unsupported fields/);
  for (const field of ['quotaTokens','tokensPerCredit','modelRates']) assert.throws(() => validateBillingPlan({ ...config, [field]: 1 }), /unsupported fields/);
});
test('Calendar expiry and reset preserve grant anchor, month end, expiry and no rollover', () => {
  const start = Date.UTC(2028, 0, 31, 12, 30, 45, 123), expiresAt = billingExpiry(start, config.duration);
  assert.equal(expiresAt, Date.UTC(2028, 3, 30, 12, 30, 45, 123));
  const grant = { startsAt: start, expiresAt, config };
  assert.equal(billingPeriod(grant, Date.UTC(2028, 1, 29, 12, 30, 45, 122))!.start, start);
  assert.deepEqual(billingPeriod(grant, Date.UTC(2028, 1, 29, 12, 30, 45, 123)), { start: Date.UTC(2028, 1, 29, 12, 30, 45, 123), end: Date.UTC(2028, 2, 31, 12, 30, 45, 123) });
  assert.equal(billingPeriod(grant, start - 1), null);
  assert.equal(billingPeriod(grant, expiresAt!), null);
});

test('plan models may be empty; allowance snapshots explicitly exclude model selection', () => {
  assert.deepEqual(validateBillingPlan({ ...config, serviceIds: [] }).serviceIds, []);
  const { serviceIds: _models, multiplier: _multiplier, ...allowance } = config;
  assert.deepEqual(billingAllowance(config), allowance);
  assert.equal('serviceIds' in billingAllowance(config), false);
  assert.notEqual(billingAllowance(config).duration, config.duration);
});

test('periodic allowance is explicit and independent of sale price; credits have no period allowance', () => {
  const periodic = { ...config, priceUsd: 100, periodAllowanceUsd: 20, periodUnit: 'week' as const };
  assert.equal(validateBillingPlan(periodic).periodAllowanceUsd, 20);
  for (const invalid of [undefined, null, 0, -1, Infinity, NaN, '20', 1_000_000_001]) {
    assert.throws(() => validateBillingPlan({ ...periodic, periodAllowanceUsd: invalid }), /periodAllowanceUsd/);
  }
  assert.throws(() => validateBillingPlan({ ...periodic, periodAllowanceUsd: 0.0000000000001 }), /periodAllowanceUsd/);
  const { periodAllowanceUsd: _allowance, periodUnit: _period, ...base } = periodic;
  const credits = { ...base, mode: 'credits' as const };
  assert.equal(validateBillingPlan(credits).priceUsd, 100);
  assert.throws(() => validateBillingPlan({ ...credits, periodAllowanceUsd: 20 }), /do not accept/);
  for (const unknown of ['periodQuotaUsd', 'maxRequests', 'maxTurns']) {
    assert.throws(() => validateBillingPlan({ ...periodic, [unknown]: 1 }), /unsupported fields/);
  }
});
