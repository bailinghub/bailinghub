import test from 'node:test';
import assert from 'node:assert/strict';
import { usdAmount, usdDecimal, usdMicros, USD_SCALE } from './billing-decimal';
import { billedUsdMicros, validateBillingPlan } from './billing-ledger';

test('USD arithmetic keeps twelve decimals and rejects silent precision loss', () => {
  assert.equal(USD_SCALE, 1_000_000_000_000n);
  assert.equal(usdMicros('0.000000001'), 1000n);
  assert.equal(usdMicros(0.1) + usdMicros(0.2), 300_000_000_000n);
  assert.equal(usdAmount(usdMicros('0.000000000001')), 1e-12);
  assert.equal(usdDecimal(usdMicros('12.012345678912')), '12.012345678912');
  for (const invalid of [1e-13, -1, NaN, Infinity, '1.0000000000001']) assert.throws(() => usdMicros(invalid));
  assert.throws(() => usdAmount(usdMicros('9007199254740990.000000000001')), /exactly/);
});
test('uniform multiplier computes money without inventing generated-image tokens', () => {
  assert.equal(usdDecimal(billedUsdMicros('0.2', 1.5)), '0.3');
  assert.equal(usdDecimal(billedUsdMicros('0.000000000001', 0.5)), '0.000000000001');
  assert.equal(usdDecimal(billedUsdMicros('0', 1.5)), '0');
  const config = { mode: 'credits', serviceIds: ['a'], priceUsd: 100, multiplier: 1.5, duration: { unit: 'day', count: 1 } };
  assert.equal(validateBillingPlan(config).multiplier, 1.5);
  assert.throws(() => validateBillingPlan({ ...config, modelRates: {} }), /unsupported/);
});
