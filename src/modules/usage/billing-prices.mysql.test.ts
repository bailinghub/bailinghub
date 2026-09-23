import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { usageHash } from './repository';
import { createUsageTestHarness } from './test-harness';
import type { PriceSnapshot, BillingPlanConfig, BillingRequest } from './billing-contracts';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
const response = { output: 'Synthetic complete result' };
const price: PriceSnapshot = { source: 'openrouter', currency: 'USD', modelId: 'synthetic-model', endpointId: 'synthetic-endpoint', fetchedAt: 1,
  lines: [{ billable: 'prompt', unit: 'token', costUsd: '0.1' }, { billable: 'completion', unit: 'token', costUsd: '0.25' }] };
async function fixture(mode: BillingPlanConfig['mode'] = 'credits', priceUsd = 100) {
  const h = await createUsageTestHarness(), tokens = h.tokens;
  const user = await h.identity.exchange(h.issuerToken, { request_key: randomUUID(), tenant: 'synthetic', subject: randomUUID(), service_id: h.service.id, model_access: 'token_gateway' });
  const config: BillingPlanConfig = { mode, serviceIds: [h.service.id], priceUsd, multiplier: 1.5, duration: { unit: 'month', count: 1 }, ...(mode === 'periodic' ? { periodUnit: 'week', periodAllowanceUsd: priceUsd } : {}) };
  const plan = await tokens.putPlan({ id: 'synthetic-plan', label: 'Synthetic USD plan', expected_revision: 0, config });
  const grant = await tokens.grant(user.session.accountId, { request_key: randomUUID(), plan_id: plan.id, expected_revision: 0 });
  const edit = (next: BillingPlanConfig, expected_revision: number) => tokens.putPlan({ id: plan.id, label: plan.label, expected_revision, config: next });
  const admit = (snapshot = price, operationId: string = randomUUID()) => tokens.admit({ actor: user.session, operationId, serviceId: h.service.id,
    conversationId: null, turnId: null, requestHash: usageHash(operationId), expectedServiceRevision: h.service.revision, serviceConfig: h.service.config, model: h.service.config.model, priceSnapshot: snapshot });
  const dispatch = async (snapshot = price) => tokens.commitDispatch((await admit(snapshot)).id, user.session);
  const finish = (request: BillingRequest, inputTokens = 3, outputTokens = 2) => tokens.complete(request.id, request.fence!, { response, usage: { inputTokens, outputTokens } });
  return { ...h, tokens, user, config, plan, grant, edit, admit, dispatch, finish };
}
for (const mode of ['credits', 'periodic'] as const) test(`USD ${mode}: immutable allowance, uniform multiplier and tiny charges`, { skip: !enabled }, async () => {
  const h = await fixture(mode);
  try {
    const first = await h.finish(await h.dispatch());
    assert.equal(first.referenceCostUsd, 0.8); assert.equal(first.billedUsd, 1.2);
    assert.deepEqual(first.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    assert.equal(first.billingRate.multiplier, 1.5);
    await h.edit({ ...h.config, priceUsd: 9999, multiplier: 2 }, 1);
    const tiny = { ...price, lines: [{ billable: 'prompt', unit: 'token' as const, costUsd: '0.000000001' }, { billable: 'completion', unit: 'token' as const, costUsd: '0.000000002' }] };
    for (let i = 0; i < 10; i++) assert.equal((await h.finish(await h.dispatch(tiny), 1, 1)).billedUsd, 0.000000006);
    const summary = await h.tokens.summary(h.user.session.accountId);
    assert.equal(summary.consumedUsd, 1.20000006); assert.equal(summary.availableUsd, 98.79999994);
    assert.deepEqual(summary.grant, h.grant); assert.equal('multiplier' in summary.grant!.config, false);
    assert.equal(summary.plan!.multiplier, 2);
    assert.equal(summary.presentation.displayValue, mode === 'credits' ? '98799.99' : '98');
    const [ledger] = await h.pool.query<any[]>('SELECT SUM(billed_usd) AS charged,SUM(input_tokens+output_tokens) AS actual FROM bz_usage_billing_ledger WHERE grant_id=?', [h.grant.id]);
    assert.equal(ledger[0].charged, '1.200000060000'); assert.equal(Number(ledger[0].actual), 25);
  } finally { await h.close(); }
});
test('original price and multiplier survive edits, ACK loss and repeat completion exactly once', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const admitted = await h.admit();
    await h.edit({ ...h.config, multiplier: 3 }, 1);
    const dispatched = await h.tokens.commitDispatch(admitted.id, h.user.session);
    const complete = await h.finish(dispatched); assert.equal(complete.billedUsd, 1.2);
    assert.deepEqual(h.tokens.view(complete).billing_rate, admitted.billingRate);
    assert.deepEqual((await h.admit({ ...price, lines: [{ billable: 'prompt', unit: 'token', costUsd: '999' }] }, admitted.operationId)).billingRate, admitted.billingRate);
    await h.finish(dispatched); await h.finish(dispatched);
    assert.equal((await h.tokens.summary(h.user.session.accountId)).consumedUsd, 1.2);
    const [count] = await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_billing_ledger'); assert.equal(count[0].n, 1);
    await assert.rejects(h.tokens.complete(dispatched.id, dispatched.fence!, { response, usage: { inputTokens: 3, outputTokens: 3 } }), { code: 'USAGE_RECEIPT_CONFLICT' });
  } finally { await h.close(); }
});
test('concurrent work may slightly overrun USD allowance; subsequent work stops and missing usage stays pending', { skip: !enabled }, async () => {
  const h = await fixture('credits', 2);
  try {
    const a = await h.dispatch(), b = await h.dispatch();
    const noUsage = await h.tokens.complete(a.id, a.fence!, { response });
    assert.equal(noUsage.resultState, 'complete'); assert.equal(noUsage.billedUsd, null);
    assert.equal((await h.tokens.summary(h.user.session.accountId)).consumedUsd, 0);
    await Promise.all([h.finish(a), h.finish(b)]);
    const summary = await h.tokens.summary(h.user.session.accountId);
    assert.equal(summary.consumedUsd, 2.4); assert.equal(summary.overageUsd, 0.4); assert.equal(summary.availableUsd, 0);
    await assert.rejects(h.admit(), { code: 'ALLOWANCE_INSUFFICIENT' });
  } finally { await h.close(); }
});
test('image accounting uses server counts, leaves tokens null, rejects changed evidence and does not trust a supplied cost', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const image: PriceSnapshot = { ...price, lines: [{ billable: 'output_image', unit: 'image', costUsd: '0.03', variant: '1k' }] };
    const r = await h.dispatch(image);
    const missing = await h.tokens.complete(r.id, r.fence!, { response });
    assert.equal(missing.billingState, 'pending'); assert.equal(missing.billedUsd, null);
    const rawUsage = { outputImageCount: 2, outputVariant: '1k', cost: 99999, providerExtension: 'synthetic-private-metadata' };
    const done = await h.tokens.complete(r.id, r.fence!, { response, rawUsage });
    assert.deepEqual(h.tokens.view(done).raw_usage, { outputImageCount: 2, outputVariant: '1k' });
    assert.equal(done.usage, null); assert.equal(done.referenceCostUsd, 0.06); assert.equal(done.billedUsd, 0.09);
    const again = await h.tokens.complete(r.id, r.fence!, { response, rawUsage }); assert.equal(again.billedUsd, 0.09);
    await assert.rejects(h.tokens.complete(r.id, r.fence!, { response, rawUsage: { ...rawUsage, outputImageCount: 3 } }), { code: 'USAGE_RECEIPT_CONFLICT' });
    const [ledger] = await h.pool.query<any[]>('SELECT input_tokens,output_tokens,billed_usd FROM bz_usage_billing_ledger');
    assert.equal(ledger[0].input_tokens, null); assert.equal(ledger[0].output_tokens, null);
  } finally { await h.close(); }
});
