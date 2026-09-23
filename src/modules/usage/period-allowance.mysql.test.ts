import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createUsageTestHarness } from './test-harness';
import { usageHash } from './repository';
import type { BillingPlanConfig, BillingRequest, PriceSnapshot } from './billing-contracts';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
const day = 86_400_000;
const price: PriceSnapshot = { source: 'openrouter', currency: 'USD', modelId: 'synthetic', endpointId: 'synthetic', fetchedAt: 1,
  lines: [{ billable: 'prompt', unit: 'token', costUsd: '1' }, { billable: 'completion', unit: 'token', costUsd: '1' }] };

test('weekly $100 sale has $20 allowance: snapshots, late settlement, reset, short final period and expiry', { skip: !enabled }, async () => {
  const h = await createUsageTestHarness();
  try {
    let now = Date.now(); const startsAt = now;
    // Control billing time only; all accounting still runs against the isolated real DB.
    Object.defineProperty(h.tokens, 'now', { value: async () => now });
    const user = await h.seedUser({ grant: false });
    const config: BillingPlanConfig = { mode: 'periodic', priceUsd: 100, periodAllowanceUsd: 20, periodUnit: 'week',
      multiplier: 1, serviceIds: [h.service.id], duration: { unit: 'day', count: 10 } };
    const body = { id: 'weekly', label: 'Synthetic weekly', expected_revision: 0, config };
    assert.equal((await h.request('/admin/api/usage/billing/plans', 'synthetic-admin', 'POST', body)).status, 200);
    const plans = await h.request('/admin/api/usage/billing/plans', 'synthetic-admin');
    assert.equal(plans.body.period_allowance_supported, true);
    const grant = await h.tokens.grant(user.accountId, { request_key: randomUUID(), plan_id: body.id, expected_revision: 0, starts_at: startsAt });
    const admit = async () => { const operationId = randomUUID(); return h.tokens.admit({ actor: user.actor, operationId, serviceId: h.service.id,
      conversationId: null, turnId: null, requestHash: usageHash(operationId), expectedServiceRevision: h.service.revision,
      serviceConfig: h.service.config, model: h.service.config.model, priceSnapshot: price }); };
    const dispatch = async () => h.tokens.commitDispatch((await admit()).id, user.actor);
    const finish = (r: BillingRequest, cost: number) => h.tokens.complete(r.id, r.fence!, { response: { output: 'synthetic' }, usage: { inputTokens: cost, outputTokens: 0 } });
    assert.equal((await h.tokens.summary(user.accountId)).availableUsd, 20);
    const first = await finish(await dispatch(), 10);
    assert.equal(first.billedUsd, 10); assert.equal(first.grantConfig.periodAllowanceUsd, 20);
    const half = await h.tokens.summary(user.accountId);
    assert.equal(half.availableUsd, 10); assert.equal(half.presentation.remaining, 50);
    assert.equal(half.presentation.displayValue, '50'); assert.equal(half.resetAt, startsAt + 7 * day);
    const late = await dispatch();
    await h.tokens.putPlan({ ...body, expected_revision: 1, config: { ...config, priceUsd: 999, periodAllowanceUsd: 200, multiplier: 2 } });
    now = startsAt + 7 * day;
    assert.equal((await h.tokens.summary(user.accountId)).availableUsd, 20);
    const settled = await finish(late, 15);
    assert.equal(settled.billedUsd, 15); assert.equal(settled.overageUsd, 5);
    const current = await h.tokens.summary(user.accountId);
    assert.equal(current.availableUsd, 20); assert.equal(current.consumedUsd, 25);
    assert.equal(current.currentPeriodConsumedUsd, 0); assert.equal(current.overageUsd, 0);
    assert.equal(current.resetAt, null); assert.equal(current.expiresAt, startsAt + 10 * day);
    assert.equal(current.grant!.config.priceUsd, 100); assert.equal(current.grant!.config.periodAllowanceUsd, 20);
    const final = await dispatch(); assert.equal(final.periodStart, now); assert.equal(final.periodEnd, startsAt + 10 * day);
    assert.equal((await finish(final, 10)).billedUsd, 20);
    await assert.rejects(admit(), { code: 'QUOTA_WINDOW_EXHAUSTED' });
    const [pools] = await h.pool.query<any[]>('SELECT allowance_usd,consumed_usd FROM bz_usage_billing_periods WHERE grant_id=? ORDER BY period_start', [grant.id]);
    assert.deepEqual(pools.map(p => [Number(p.allowance_usd), Number(p.consumed_usd)]), [[20,25],[20,20]]);
    now = startsAt + 10 * day;
    const expired = await h.tokens.summary(user.accountId);
    assert.equal(expired.availableUsd, 0); assert.equal(expired.presentation.state, 'expired');
    await assert.rejects(admit(), { code: 'SUBSCRIPTION_EXPIRED' });
  } finally { await h.close(); }
});

test('explicit migration converts each old snapshot and idempotency result without changing credits or existing allowances', { skip: !enabled }, async () => {
  const h = await createUsageTestHarness();
  try {
    const user = await h.seedUser({ grant: false });
    const config: BillingPlanConfig = { mode: 'periodic', priceUsd: 100, periodAllowanceUsd: 100, periodUnit: 'week', multiplier: 1,
      serviceIds: [h.service.id], duration: { unit: 'day', count: 10 } };
    await h.tokens.putPlan({ id: 'legacy', label: 'Synthetic migration', expected_revision: 0, config });
    const body = { request_key: randomUUID(), plan_id: 'legacy', expected_revision: 0 };
    const grant = await h.tokens.grant(user.accountId, body);
    const operationId = randomUUID();
    const r = await h.tokens.admit({ actor: user.actor, operationId, serviceId: h.service.id, conversationId: null, turnId: null,
      requestHash: usageHash(operationId), expectedServiceRevision: h.service.revision, serviceConfig: h.service.config,
      model: h.service.config.model, priceSnapshot: price });
    const dispatched = await h.tokens.commitDispatch(r.id, user.actor);
    // Produce a representative pre-upgrade fixture with independently edited template price.
    await h.pool.query("UPDATE bz_usage_billing_plans SET config_json=JSON_SET(JSON_REMOVE(config_json,'$.periodAllowanceUsd'),'$.priceUsd',300) WHERE id='legacy'");
    await h.pool.query("UPDATE bz_usage_billing_grants SET config_json=JSON_REMOVE(config_json,'$.periodAllowanceUsd')");
    await h.pool.query("UPDATE bz_usage_billing_requests SET grant_json=JSON_REMOVE(grant_json,'$.periodAllowanceUsd')");
    await h.pool.query("UPDATE bz_usage_changes SET result_json=JSON_REMOVE(result_json,'$.config.periodAllowanceUsd') WHERE JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.config.mode'))='periodic'");
    await h.tokens.putPlan({ id: 'explicit', label: 'Synthetic explicit', expected_revision: 0, config: { ...config, periodAllowanceUsd: 20 } });
    await h.tokens.putPlan({ id: 'credits', label: 'Synthetic credits', expected_revision: 0, config: { mode: 'credits', priceUsd: 75, serviceIds: [], multiplier: 1, duration: { unit: 'forever', count: 0 } } });
    const migration = await readFile(new URL('../../../sql/064_period_plan_allowance.sql', import.meta.url), 'utf8');
    await h.pool.query(migration); await h.pool.query(migration);
    const plans = await h.tokens.listPlans();
    assert.equal(plans.find(p => p.id === 'legacy')!.config.periodAllowanceUsd, 300);
    assert.equal(plans.find(p => p.id === 'explicit')!.config.periodAllowanceUsd, 20);
    assert.equal(plans.find(p => p.id === 'credits')!.config.periodAllowanceUsd, undefined);
    const replay = await h.tokens.grant(user.accountId, body);
    assert.equal(replay.id, grant.id); assert.equal(replay.config.periodAllowanceUsd, 100);
    assert.equal((await h.tokens.findRequest(user.actor, operationId))!.grantConfig.periodAllowanceUsd, 100);
    const done = await h.tokens.complete(r.id, dispatched.fence!, { response: { output: 'synthetic' }, usage: { inputTokens: 10, outputTokens: 0 } });
    assert.equal(done.billedUsd, 10); assert.equal(done.overageUsd, 0);
    const summary = await h.tokens.summary(user.accountId);
    assert.equal(summary.availableUsd, 90); assert.equal(summary.presentation.remaining, 90);
  } finally { await h.close(); }
});
