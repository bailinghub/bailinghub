import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getBillingRepository } from './billing-repository';
import { usageHash } from './repository';
import { createUsageTestHarness } from './test-harness';
import type { UsageActor, UsageService } from './contracts';
import type { PriceSnapshot, BillingPlanConfig } from './billing-contracts';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
const response = { choices: [{ message: { role: 'assistant', content: 'Synthetic result' } }] };
const admin = 'synthetic-admin';
async function fixture(mode: BillingPlanConfig['mode'] = 'credits') {
  const h = await createUsageTestHarness(), tokens = getBillingRepository(h.repository);
  const user = await h.identity.exchange(h.issuerToken, { request_key: randomUUID(), tenant: 'synthetic', subject: randomUUID(),
    service_id: h.service.id, model_access: 'token_gateway' });
  const config: BillingPlanConfig = { mode, serviceIds: [h.service.id], priceUsd: 1000, multiplier: 1,
    duration: { unit: 'month', count: 2 }, ...(mode === 'periodic' ? { periodUnit: 'week', periodAllowanceUsd: 1000 } : {}) };
  const plan = await tokens.putPlan({ id: 'synthetic-plan', label: 'Synthetic allowance', expected_revision: 0, config });
  const grantBody = { request_key: randomUUID(), plan_id: plan.id, expected_revision: 0 };
  const original = await tokens.grant(user.session.accountId, grantBody);
  const model = (id: string) => h.repository.putService({ id, label: `Synthetic ${id}`, expectedRevision: 0, config: { ...h.service.config, model: `model-${id}` } });
  const edit = (config: BillingPlanConfig, expected_revision: number, state: 'active' | 'suspended' = 'active') =>
    tokens.putPlan({ id: plan.id, label: plan.label, expected_revision, state, config });
  const priceSnapshot: PriceSnapshot = { source:'openrouter',modelId:'synthetic/model',endpointId:'synthetic-endpoint',currency:'USD',fetchedAt:Date.now(),lines:[{billable:'prompt',unit:'token',costUsd:'1'},{billable:'completion',unit:'token',costUsd:'1'}] };
  const admit = (service: UsageService = h.service, actor: UsageActor = user.session, operationId: string = randomUUID()) =>
    tokens.admit({ actor, operationId, serviceId: service.id, conversationId: 'synthetic-conversation', turnId: 'synthetic-turn',
      requestHash: usageHash(operationId), expectedServiceRevision: service.revision, serviceConfig: service.config, model: service.config.model, priceSnapshot });
  const remove = (service: UsageService = h.service) => h.repository.deleteService({ id: service.id, expectedRevision: service.revision, requestId: randomUUID(), actor: admin });
  const finish = async (service: UsageService = h.service) => {
    const r = await admit(service), dispatched = await tokens.commitDispatch(r.id, user.session);
    return tokens.complete(r.id, dispatched.fence!, { response, usage: { inputTokens: 20, outputTokens: 5 } });
  };
  return { ...h, tokens, user, config, plan, grantBody, original, model, edit, admit, remove, finish };
}

for (const mode of ['credits', 'periodic'] as const) test(`dynamic ${mode} plan: add B through same credential, share balance, keep original allowance and dates`, { skip: !enabled }, async () => {
  const h = await fixture(mode);
  try {
    const b = await h.model('new-model');
    await assert.rejects(h.admit(b), { code: 'SERVICE_NOT_ENTITLED', details: { next_action: 'select_model' } });
    await h.finish();
    const before = await h.tokens.summary(h.user.session.accountId);
    const edited = await h.edit({ ...h.config, serviceIds: [h.service.id, b.id], priceUsd: 9000,
      duration: { unit: 'month', count: 9 }, ...(mode === 'periodic' ? { periodUnit: 'day' } : {}) }, 1);
    const current = await h.tokens.summary(h.user.session.accountId);
    assert.deepEqual(current.grant, h.original); assert.deepEqual(current.grant, before.grant);
    assert.equal(current.resetAt, before.resetAt); assert.equal(current.expiresAt, before.expiresAt);
    assert.equal(current.availableUsd, 975);
    assert.deepEqual(current.plan, { id: h.plan.id, label: h.plan.label, revision: edited.revision, serviceIds: [h.service.id, b.id], multiplier: 1 });
    const sent = await h.finish(b);
    assert.equal('serviceIds' in sent.grantConfig, false); assert.equal('serviceIds' in current.grant!.config, false);
    const summary = await h.tokens.summary(h.user.session.accountId);
    assert.equal(summary.availableUsd, 950); assert.equal(summary.consumedUsd, 50);
    assert.equal(summary.grant!.revision, h.original.revision); assert.equal(summary.resetAt, before.resetAt);
    const [issuer] = await h.pool.query<any[]>('SELECT service_ids_json FROM bz_usage_issuers WHERE id=?', ['synthetic-product']);
    assert.deepEqual(issuer[0].service_ids_json, [h.service.id]);
    const [raw] = await h.pool.query<any[]>('SELECT config_json FROM bz_usage_billing_grants WHERE id=?', [h.original.id]);
    assert.equal('serviceIds' in raw[0].config_json, false);
  } finally { await h.close(); }
});

test('dynamic plan: paused plan only prevents new grants; empty and missing directories never use a grant snapshot', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    await h.edit(h.config, 1, 'suspended');
    await h.finish();
    const second = await h.seedUser({ grant: false });
    await assert.rejects(h.tokens.grant(second.accountId, { request_key: randomUUID(), plan_id: h.plan.id, expected_revision: 0 }), { code: 'SERVICE_NOT_ENTITLED' });
    const admitted = await h.admit();
    await h.edit({ ...h.config, serviceIds: [] }, 2, 'suspended');
    await assert.rejects(h.tokens.commitDispatch(admitted.id, h.user.session), { code: 'SERVICE_NOT_ENTITLED' });
    await assert.rejects(h.admit(), { code: 'SERVICE_NOT_ENTITLED' });
    assert.deepEqual((await h.tokens.summary(h.user.session.accountId)).plan!.serviceIds, []);
    await h.pool.query('DELETE FROM bz_usage_billing_plans WHERE id=?', [h.plan.id]);
    assert.equal((await h.tokens.summary(h.user.session.accountId)).plan, null);
    await assert.rejects(h.admit(), { code: 'SERVICE_NOT_ENTITLED' });
    assert.deepEqual((await h.tokens.summary(h.user.session.accountId)).grant, h.original);
  } finally { await h.close(); }
});

test('service delete removes all plan selections atomically, keeps grant/periods and previews impact with exact totals', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const b = await h.model('second-model');
    await h.edit({ ...h.config, serviceIds: [h.service.id, b.id] }, 1);
    await h.tokens.putPlan({ id: 'paused-plan', label: 'Paused template', expected_revision: 0, state: 'suspended', config: h.config });
    await h.finish();
    const before = await h.tokens.summary(h.user.session.accountId);
    const [periodsBefore] = await h.pool.query<any[]>('SELECT * FROM bz_usage_billing_periods');
    const [grantBefore] = await h.pool.query<any[]>('SELECT * FROM bz_usage_billing_grants WHERE id=?', [h.original.id]);
    const preview = await h.repository.serviceReferences(h.service.id);
    assert.equal(preview.deletable, true); assert.equal(preview.plans.total, 2); assert.equal(preview.accounts.total, 1); assert.equal(preview.requests.total, 1);
    assert.deepEqual(preview.accounts.items[0]!.serviceIds, [h.service.id, b.id]);
    assert(!JSON.stringify(preview).includes('serviceConfig')); assert(!JSON.stringify(preview).includes('requestHash'));
    const receipt = await h.remove();
    assert.equal(receipt.affected_plan_count, 2); assert.equal(receipt.affected_account_count, 1); assert.equal(receipt.affected_request_count, 1);
    const plans = await h.tokens.listPlans();
    assert.deepEqual(plans.find(p => p.id === h.plan.id)!.config.serviceIds, [b.id]);
    assert.equal(plans.find(p => p.id === h.plan.id)!.revision, 3);
    assert.deepEqual(plans.find(p => p.id === 'paused-plan')!.config.serviceIds, []);
    assert.equal(plans.find(p => p.id === 'paused-plan')!.revision, 2);
    const [periodsAfter] = await h.pool.query<any[]>('SELECT * FROM bz_usage_billing_periods');
    const [grantAfter] = await h.pool.query<any[]>('SELECT * FROM bz_usage_billing_grants WHERE id=?', [h.original.id]);
    assert.deepEqual(periodsAfter, periodsBefore); assert.deepEqual(grantAfter, grantBefore);
    assert.equal((await h.tokens.summary(h.user.session.accountId)).availableUsd, before.availableUsd);
    await h.finish(b); await h.remove(b);
    const after = await h.tokens.summary(h.user.session.accountId);
    assert.deepEqual(after.plan!.serviceIds, []); assert.equal(after.availableUsd, 950); assert.deepEqual(after.grant, h.original);
    await assert.rejects(h.repository.putService({ ...h.service, expectedRevision: 2 }), { code: 'USAGE_SERVICE_DELETED' });
  } finally { await h.close(); }
});

test('service delete fences unissued work but preserves dispatched/unknown/cancelled evidence and late settlement', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const unsent = await h.admit(), a = await h.admit(), b = await h.admit(), completed = await h.admit();
    const pa = await h.tokens.commitDispatch(a.id, h.user.session), pb = await h.tokens.commitDispatch(b.id, h.user.session);
    const pc = await h.tokens.commitDispatch(completed.id, h.user.session);
    await h.tokens.markUnknown(a.id, pa.fence!, 'synthetic_confirmation_lost');
    await h.tokens.cancel(h.user.session, b.operationId);
    await h.tokens.complete(completed.id, pc.fence!, { response });
    const receipt = await h.remove(); assert.equal(receipt.affected_request_count, 4);
    await assert.rejects(h.tokens.commitDispatch(unsent.id, h.user.session), { code: 'SERVICE_NOT_ENTITLED' });
    const restored = await h.tokens.findRequest(h.user.session, a.operationId); assert.equal(restored?.state, 'unknown');
    await h.tokens.complete(a.id, pa.fence!, { response, usage: { inputTokens: 20, outputTokens: 5 } });
    await h.tokens.complete(b.id, pb.fence!, { response: { tool_calls: [{ id: 'never-execute' }] }, usage: { inputTokens: 10, outputTokens: 5 } });
    const late = await h.tokens.findRequest(h.user.session, b.operationId);
    assert.equal(late?.state, 'cancelled'); assert.equal('response' in h.tokens.view(late!), false);
    const complete = await h.tokens.complete(completed.id, pc.fence!, { response, usage: { inputTokens: 5, outputTokens: 5 } });
    assert.equal(complete.billingState, 'settled'); assert.equal((await h.tokens.summary(h.user.session.accountId)).consumedUsd, 50);
    await h.tokens.findRequest(h.user.session, completed.operationId);
    assert.equal((await h.tokens.summary(h.user.session.accountId)).consumedUsd, 50);
    assert.equal((await h.tokens.cancel(h.user.session, unsent.operationId)).billedUsd, 0);
    const other = await h.seedUser({ grant: false });
    assert.equal(await h.tokens.findRequest(other.actor, a.operationId), null);
    await assert.rejects(h.tokens.cancel(other.actor, a.operationId), { code: 'USAGE_OPERATION_NOT_FOUND' });
  } finally { await h.close(); }
});

test('grant snapshots and idempotent receipts never override current plan model selections', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const r = await h.admit();
    await h.pool.query("UPDATE bz_usage_billing_grants SET config_json=JSON_SET(config_json,'$.serviceIds',JSON_ARRAY('unselected')) WHERE id=?", [h.original.id]);
    await h.pool.query("UPDATE bz_usage_billing_requests SET grant_json=JSON_SET(grant_json,'$.serviceIds',JSON_ARRAY('unselected')) WHERE id=?", [r.id]);
    await h.pool.query("UPDATE bz_usage_changes SET result_json=JSON_SET(result_json,'$.config.serviceIds',JSON_ARRAY('unselected')) WHERE JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.id'))=?", [h.original.id]);
    const summary = await h.tokens.summary(h.user.session.accountId);
    assert.deepEqual(summary.grant, h.original); assert.deepEqual(summary.plan!.serviceIds, [h.service.id]);
    assert.equal('serviceIds' in (await h.tokens.findRequest(h.user.session, r.operationId))!.grantConfig, false);
    assert.deepEqual(await h.tokens.grant(h.user.session.accountId, h.grantBody), h.original);
    const controlBody = { request_key: randomUUID(), expected_revision: 1, state: 'suspended' };
    const suspended = await h.tokens.control(h.user.session.accountId, controlBody);
    await h.pool.query("UPDATE bz_usage_changes SET result_json=JSON_SET(result_json,'$.config.serviceIds',JSON_ARRAY('unselected')) WHERE JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.id'))=?", [h.original.id]);
    assert.deepEqual(await h.tokens.control(h.user.session.accountId, controlBody), suspended);
  } finally { await h.close(); }
});

test('dynamic plan permissions: single-service credential remains bounded; discarded account-model endpoint is gone', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const b = await h.model('selected-b'); await h.edit({ ...h.config, serviceIds: [h.service.id, b.id] }, 1);
    const single = await h.identity.exchange(h.issuerToken, { request_key: randomUUID(), tenant: 'synthetic', subject: randomUUID(), service_id: h.service.id, model_access: 'service' });
    await h.tokens.grant(single.session.accountId, { request_key: randomUUID(), plan_id: h.plan.id, expected_revision: 0 });
    await assert.rejects(h.admit(b, single.session), { code: 'USAGE_ACCOUNT_FORBIDDEN' });
    assert.equal((await h.request(`/admin/api/usage/services/${h.service.id}/references`, 'synthetic-auditor')).status, 403);
    assert.equal((await h.request(`/admin/api/usage/services/${h.service.id}/references`, admin)).status, 200);
    assert.equal((await h.request(`/admin/api/usage/billing/accounts/${h.user.session.accountId}/models`, admin, 'POST', {})).status, 404);
    assert.equal((await h.request('/admin/api/usage/billing/plans', 'synthetic-auditor', 'POST', { id: h.plan.id, label: h.plan.label, expected_revision: 2, config: h.config })).status, 403);
    await h.pool.query("UPDATE bz_usage_members SET state='revoked' WHERE account_id=? AND user_id=?", [h.user.session.accountId, h.user.session.userId]);
    await assert.rejects(h.admit(b), { code: 'USAGE_ACCOUNT_FORBIDDEN' });
  } finally { await h.close(); }
});

test('concurrent model deletion and plan creation/edits leave no selectable deleted identity; deletion permits original completion', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    for (let i = 0; i < 5; i++) {
      const service = await h.model(`race-${i}`);
      const results = await Promise.allSettled([
        h.tokens.putPlan({ id: `race-plan-${i}`, label: 'Concurrent template', expected_revision: 0, config: { ...h.config, serviceIds: [service.id] } }),
        h.remove(service),
      ]);
      assert.equal(results[1]!.status, 'fulfilled', JSON.stringify(results));
      if (results[0]!.status === 'rejected') assert.equal(results[0]!.reason.code, 'USAGE_SERVICE_NOT_FOUND');
      const p = (await h.tokens.listPlans()).find(p => p.id === `race-plan-${i}`);
      if (p) assert.deepEqual(p.config.serviceIds, []);
      assert.equal(await h.repository.getService(service.id), null);
    }
    const r = await h.admit(), p = await h.tokens.commitDispatch(r.id, h.user.session);
    const results = await Promise.allSettled([
      h.edit({ ...h.config, priceUsd: 3000 }, 1),
      h.remove(),
      h.tokens.complete(r.id, p.fence!, { response, usage: { inputTokens: 20, outputTokens: 5 } }),
    ]);
    assert.equal(results[1]!.status, 'fulfilled', JSON.stringify(results)); assert.equal(results[2]!.status, 'fulfilled', JSON.stringify(results));
    if (results[0]!.status === 'rejected') assert(['USAGE_SERVICE_NOT_FOUND','USAGE_REVISION_CONFLICT'].includes(results[0]!.reason.code));
    const summary = await h.tokens.summary(h.user.session.accountId);
    assert.deepEqual(summary.plan!.serviceIds, []); assert.deepEqual(summary.grant, h.original); assert.equal(summary.availableUsd, 975);
  } finally { await h.close(); }
});

test('one plan multiplier applies to all models while original requests retain their accepted USD price snapshot', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const second = await h.model('shared-multiplier');
    await h.edit({ ...h.config, serviceIds:[h.service.id, second.id], multiplier:1.5 }, 1);
    const original = await h.admit();
    await h.edit({ ...h.config, serviceIds:[h.service.id, second.id], multiplier:2 }, 2);
    const sent = await h.tokens.commitDispatch(original.id, h.user.session);
    const completed = await h.tokens.complete(original.id, sent.fence!, {response, usage:{inputTokens:20,outputTokens:5}});
    assert.equal(completed.referenceCostUsd,25);
    assert.equal(completed.billedUsd,37.5);
    assert.equal(completed.billingRate.multiplier,1.5);
    const next = await h.finish(second);
    assert.equal(next.referenceCostUsd,25);
    assert.equal(next.billedUsd,50);
    assert.equal(next.billingRate.multiplier,2);
    assert.equal((await h.tokens.summary(h.user.session.accountId)).availableUsd,912.5);
  } finally {await h.close();}
});
