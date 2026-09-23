import test from 'node:test';
import assert from 'node:assert/strict';
import { usagePresentation } from './billing-presentation';
import type { BillingGrant } from './billing-contracts';

const grant: BillingGrant = { id: 'synthetic', accountId: 'synthetic', planId: 'synthetic', planRevision: 1, revision: 1,
  label: 'Synthetic', state: 'active', sourceOwner: 'hub', startsAt: 1000, expiresAt: 3000,
  config: { mode: 'credits', priceUsd: 1000, duration: { unit: 'day', count: 1 } } };

test('credits are a fixed display projection of USD and small positive balances are not zero', () => {
  for (const [available, expected] of [[0.00029,'0.29'],[0.0011,'1.1'],[0.000001,'<0.01'],[0.000019,'0.01'],[1,'1000'],[0,'0']] as const) {
    const view = usagePresentation('active', grant, available, 2000);
    assert.equal(view.kind, 'credits'); assert.equal(view.displayValue, expected);
    assert.equal(view.remaining, available * 1000); assert.equal(view.total, 1_000_000);
    assert.equal(view.state, available ? 'active' : 'depleted');
  }
});

test('periodic projection describes remaining percentage, clamps the range and distinguishes sub-one-percent', () => {
  const periodic = { ...grant, config: { ...grant.config, mode: 'periodic' as const, periodAllowanceUsd: 1000, periodUnit: 'day' as const } };
  for (const [available, expected] of [[1000,'100'],[125,'12'],[10,'1'],[1,'<1'],[0,'0'],[-25,'0'],[1500,'100']] as const) {
    const view = usagePresentation('active', periodic, available, 2000);
    assert.equal(view.kind, 'percentage'); assert.equal(view.total, 100); assert.equal(view.displayValue, expected);
    assert.equal(view.remaining, Math.min(100, Math.max(0, available) / 1000 * 100));
  }
});

test('no allowance and nonusable states never fabricate a zero remaining allowance', () => {
  assert.deepEqual(usagePresentation('active', null, 0, 2000), {
    schema: 'bailing.usage-presentation.v1', kind: 'none', state: 'unavailable', remaining: null, total: null, displayValue: null,
  });
  for (const [accountState, g, now, state] of [
    ['active', grant, 999, 'not_started'], ['active', grant, 3000, 'expired'],
    ['suspended', grant, 2000, 'suspended'], ['active', { ...grant, state: 'suspended' as const }, 2000, 'suspended'],
    ['suspended', grant, 4000, 'suspended'],
  ] as const) {
    const view = usagePresentation(accountState, g, 1000, now);
    assert.equal(view.state, state); assert.equal(view.remaining, null); assert.equal(view.displayValue, null); assert.equal(view.total, 1_000_000);
  }
  assert.equal(usagePresentation('active', grant, 1000, 1000).state, 'active');
  assert.equal(usagePresentation('active', { ...grant, expiresAt: null }, 1000, 4000).state, 'active');
});

test('periodic percentage divides by period allowance instead of sale price', () => {
  const periodic: BillingGrant = { ...grant, config: { ...grant.config, mode: 'periodic', periodUnit: 'week', priceUsd: 100, periodAllowanceUsd: 20 } };
  assert.equal(usagePresentation('active', periodic, 10, 2000).remaining, 50);
  assert.equal(usagePresentation('active', periodic, 10, 2000).displayValue, '50');
  assert.equal(usagePresentation('active', periodic, 20, 2000).remaining, 100);
});
