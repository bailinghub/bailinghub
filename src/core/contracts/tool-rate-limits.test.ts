import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveToolRateLimit, normalizeToolRateLimitPolicies } from './tool-rate-limits';
import { LocalSlidingWindowRateLimiter } from './tools';

test('120/hour permits a burst and remains occupied after one minute; windows expire exactly', () => {
  let now = 0;
  const limiter = new LocalSlidingWindowRateLimiter(() => now);
  for (let n = 0; n < 120; n++) assert.equal(limiter.consume('tool:store:images', 120, 3600), false);
  assert.equal(limiter.consume('tool:store:images', 120, 3600), true);
  now = 60_001;
  assert.equal(limiter.consume('tool:store:images', 120, 3600), true);
  // A second user's different session still hits the same provider/tool bucket; a different provider does not.
  assert.equal(limiter.consume('tool:another:images', 120, 3600), false);
  now = 3_600_000;
  assert.equal(limiter.consume('tool:store:images', 120, 3600), false);
});

test('all supported windows and disabled limits retain their original units', () => {
  for (const windowSec of [1, 60, 3600, 86400]) {
    let now = 0;
    const limiter = new LocalSlidingWindowRateLimiter(() => now);
    assert.equal(limiter.consume('tool', 2, windowSec), false);
    assert.equal(limiter.consume('tool', 2, windowSec), false);
    now = windowSec * 1000 - 1;
    assert.deepEqual(limiter.consumeAll([{ bucket: 'tool', limit: 2, windowSec }]), { limited: true, bucket: 'tool', retryAfterMs: 1 });
    now++;
    assert.equal(limiter.consume('tool', 2, windowSec), false);
    assert.equal(limiter.consume('tool', 0, windowSec), false);
  }
});

test('rejecting either gate never burns quota in the other gate', () => {
  for (const blocked of ['tool', 'provider']) {
    const limiter = new LocalSlidingWindowRateLimiter(() => 0);
    limiter.consume(blocked, 1);
    const other = blocked === 'tool' ? 'provider' : 'tool';
    for (let n = 0; n < 5; n++) assert.equal(limiter.consumeAll([
      { bucket: 'tool', limit: 1, windowSec: 60 }, { bucket: 'provider', limit: 1, windowSec: 60 },
    ]).limited, true);
    assert.equal(limiter.consume(other, 1), false);
  }
});

test('default, per-tool overrides and inheritance preserve raw declaration without changing it', () => {
  const tool = { name: 'images_update', rateLimit: { count: 120, window: '1h' as const }, rateLimitPerMin: 2 };
  const original = structuredClone(tool);
  assert.equal(effectiveToolRateLimit(tool).window_sec, 3600);
  const policies = normalizeToolRateLimitPolicies({ default: { mode: 'disabled' }, overrides: { images_update: { mode: 'inherit' } } });
  assert.equal(effectiveToolRateLimit(tool, policies).count, 120);
  assert.equal(effectiveToolRateLimit({ ...tool, name: 'another' }, policies).enabled, false);
  policies.overrides.images_update = { mode: 'custom', count: 1000, window: '1m' };
  assert.equal(effectiveToolRateLimit(tool, policies).count, 1000);
  assert.deepEqual(tool, original);
  for (const count of [0, -1, 1.5, '120', Infinity, 1000001]) {
    assert.throws(() => normalizeToolRateLimitPolicies({ default: { mode: 'custom', count, window: '1h' } }));
  }
  assert.throws(() => normalizeToolRateLimitPolicies({ default: { mode: 'disabled', count: 120 } }));
});
