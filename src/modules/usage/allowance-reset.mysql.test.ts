import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createUsageTestHarness } from './test-harness';
import { usageHash } from './repository';
import type { BillingPlanConfig, BillingRequest, PriceSnapshot } from './billing-contracts';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
const day = 86_400_000, admin = 'synthetic-admin';
const price: PriceSnapshot = { source: 'openrouter', currency: 'USD', modelId: 'synthetic', endpointId: 'synthetic', fetchedAt: 1,
  lines: [{ billable: 'prompt', unit: 'token', costUsd: '1' }, { billable: 'completion', unit: 'token', costUsd: '1' }] };
async function fixture(mode: 'periodic' | 'credits' = 'periodic', sourceOwner = 'hub') {
  const h = await createUsageTestHarness();
  let now = Date.now(); const startsAt = now;
  Object.defineProperty(h.tokens, 'now', { value: async () => now });
  const user = await h.seedUser({ grant: false });
  const config: BillingPlanConfig = { mode, priceUsd: 100, multiplier: 1, serviceIds: [h.service.id],
    ...(mode === 'periodic' ? { periodAllowanceUsd: 20, periodUnit: 'week' as const } : {}), duration: { unit: 'day', count: 30 } };
  const plan = await h.tokens.putPlan({ id: 'synthetic-reset', label: 'Synthetic reset', expected_revision: 0, config });
  const grant = await h.tokens.grant(user.accountId, { request_key: randomUUID(), plan_id: plan.id, expected_revision: 0, starts_at: now }, sourceOwner);
  const path = `/admin/api/usage/billing/accounts/${user.accountId}/reset`;
  const reset = (revision: number, key = randomUUID()) => h.request(path, admin, 'POST', { request_key: key, expected_revision: revision });
  const admit = async () => { const operationId = randomUUID(); return h.tokens.admit({ actor: user.actor, operationId, serviceId: h.service.id,
    conversationId: null, turnId: null, requestHash: usageHash(operationId), expectedServiceRevision: h.service.revision,
    serviceConfig: h.service.config, model: h.service.config.model, priceSnapshot: price }); };
  const dispatch = async () => h.tokens.commitDispatch((await admit()).id, user.actor);
  const finish = (r: BillingRequest, cost: number) => h.tokens.complete(r.id, r.fence!, { response: { output: 'synthetic' }, usage: { inputTokens: cost, outputTokens: 0 } });
  return { ...h, user, config, plan, grant, path, reset, dispatch, finish, startsAt, setNow: (value: number) => { now = value; } };
}

test('manual reset restores the original weekly allowance, moves the anchor and preserves expiry and late settlement', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const late = await h.dispatch();
    await h.finish(await h.dispatch(), 20);
    assert.equal((await h.tokens.summary(h.user.accountId)).presentation.remaining, 0);
    await h.tokens.putPlan({ id: h.plan.id, label: h.plan.label, expected_revision: 1, config: { ...h.config, priceUsd: 999, periodAllowanceUsd: 200 } });
    h.setNow(h.startsAt + 2 * day);
    const reset = await h.reset(1); assert.equal(reset.status, 200);
    assert.notEqual(reset.body.id, h.grant.id);
    assert.equal(reset.body.reset.previousGrantId, h.grant.id);
    assert.equal(reset.body.reset.actor, 'admin-token');
    const current = await h.tokens.summary(h.user.accountId);
    assert.equal(current.availableUsd, 20); assert.equal(current.presentation.remaining, 100);
    assert.equal(current.resetAt, h.startsAt + 9 * day); assert.equal(current.expiresAt, h.grant.expiresAt);
    assert.equal(current.grant!.config.priceUsd, 100);
    const done = await h.finish(late, 7);
    assert.equal(done.grantId, h.grant.id);
    assert.deepEqual(await h.finish(late, 7), done);
    assert.equal((await h.tokens.summary(h.user.accountId)).availableUsd, 20);
    const [pools] = await h.pool.query<any[]>('SELECT consumed_usd FROM bz_usage_billing_periods WHERE grant_id=?', [h.grant.id]);
    assert.equal(Number(pools[0].consumed_usd), 27);
    assert.equal((await h.tokens.findRequest(h.user.actor, late.operationId))!.resultState, 'complete');
    h.setNow(h.startsAt + 28 * day);
    assert.equal((await h.reset(2)).status, 200);
    const final = await h.tokens.summary(h.user.accountId);
    assert.equal(final.availableUsd, 20); assert.equal(final.resetAt, null); assert.equal(final.expiresAt, h.grant.expiresAt);
    h.setNow(h.grant.expiresAt!);
    assert.equal((await h.reset(3)).body.error, 'SERVICE_NOT_ENTITLED');
  } finally { await h.close(); }
});

test('reset retries and concurrent clicks issue one allowance; replay after spending does not refill it', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const key = randomUUID();
    const [first, duplicate] = await Promise.all([h.reset(1, key), h.reset(1, key)]);
    assert.equal(first.status, 200); assert.deepEqual(duplicate.body, first.body);
    await h.finish(await h.dispatch(), 5);
    assert.deepEqual((await h.reset(1, key)).body, first.body);
    assert.equal((await h.tokens.summary(h.user.accountId)).availableUsd, 15);
    assert.equal((await h.reset(2, key)).body.error, 'USAGE_IDEMPOTENCY_CONFLICT');
    assert.equal((await h.reset(1)).body.error, 'USAGE_REVISION_CONFLICT');
    const results = await Promise.all([h.reset(2), h.reset(2)]);
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal(results.filter(r => r.body.error === 'USAGE_REVISION_CONFLICT').length, 1);
    assert.equal((await h.tokens.summary(h.user.accountId)).availableUsd, 20);
    const [rows] = await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_billing_grants WHERE account_id=?', [h.user.accountId]);
    assert.equal(Number(rows[0].n), 3);
    const [receipts] = await h.pool.query<any[]>('SELECT result_json FROM bz_usage_changes WHERE JSON_EXTRACT(result_json,\'$.reset\') IS NOT NULL');
    assert.equal(receipts.length, 2);
  } finally { await h.close(); }
});

test('credits reset restores the pack without periodic renewal or extending its life', { skip: !enabled }, async () => {
  const h = await fixture('credits');
  try {
    await h.finish(await h.dispatch(), 40);
    assert.equal((await h.tokens.summary(h.user.accountId)).availableUsd, 60);
    h.setNow(h.startsAt + day);
    assert.equal((await h.reset(1)).status, 200);
    const summary = await h.tokens.summary(h.user.accountId);
    assert.equal(summary.availableUsd, 100); assert.equal(summary.presentation.kind, 'credits');
    assert.equal(summary.resetAt, null); assert.equal(summary.expiresAt, h.grant.expiresAt);
  } finally { await h.close(); }
});

test('reset enforces adjustment permission, input shape, active account and active effective grant', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const body = { request_key: randomUUID(), expected_revision: 1 };
    assert.equal((await h.request(h.path, 'synthetic-auditor', 'POST', body)).status, 403);
    assert.equal((await h.request(h.path, admin, 'POST', { ...body, priceUsd: 999 })).status, 400);
    assert.equal((await h.request(h.path, admin, 'POST', { expected_revision: 1 })).status, 400);
    h.setNow(h.startsAt - 1);
    assert.equal((await h.reset(1)).body.error, 'SERVICE_NOT_ENTITLED');
    h.setNow(h.startsAt);
    await h.tokens.control(h.user.accountId, { request_key: randomUUID(), expected_revision: 1, state: 'suspended' });
    assert.equal((await h.reset(2)).body.error, 'SERVICE_NOT_ENTITLED');
    await h.tokens.control(h.user.accountId, { request_key: randomUUID(), expected_revision: 2, state: 'active' });
    await h.repository.setAccountState({ accountId: h.user.accountId, expectedRevision: 1, requestId: randomUUID(), actor: admin, state: 'suspended' });
    assert.equal((await h.reset(3)).body.error, 'USAGE_ACCOUNT_SUSPENDED');
    const [rows] = await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_billing_grants WHERE account_id=?', [h.user.accountId]);
    assert.equal(Number(rows[0].n), 1);
  } finally { await h.close(); }
});

test('external entitlement owners retain control over their allowance', { skip: !enabled }, async () => {
  const h = await fixture('periodic', 'issuer:synthetic-product');
  try { assert.equal((await h.reset(1)).body.error, 'USAGE_SOURCE_CONFLICT'); }
  finally { await h.close(); }
});
