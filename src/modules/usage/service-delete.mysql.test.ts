import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getBillingRepository } from './billing-repository';
import { createUsageTestHarness } from './test-harness';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
const admin = 'synthetic-admin';
const config = (serviceId: string) => ({ mode: 'credits', serviceIds: [serviceId], priceUsd: 1000, multiplier: 1,
  duration: { unit: 'month', count: 1 } });
async function fixture() {
  const h = await createUsageTestHarness(), tokens = getBillingRepository(h.repository);
  const deletion = (request_key = randomUUID(), expected_revision = h.service.revision) =>
    h.request(`/admin/api/usage/services/${h.service.id}`, admin, 'DELETE', { request_key, expected_revision });
  const plan = () => tokens.putPlan({ id: 'synthetic-plan', label: 'Synthetic allowance', expected_revision: 0, config: config(h.service.id) });
  return { ...h, tokens, deletion, plan };
}

test('service deletion: encoded identity is decoded once; malformed and encoded separators are rejected', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const service = await h.repository.putService({ id: 'synthetic:model', label: 'Synthetic encoded', expectedRevision: 0, config: h.service.config });
    const body = { request_key: randomUUID(), expected_revision: 1 };
    for (const segment of ['bad%ZZ', 'bad%2Fname', 'bad%253Aname']) {
      const invalid = await h.request(`/admin/api/usage/services/${segment}`, admin, 'DELETE', body);
      assert.equal(invalid.status, 400, JSON.stringify(invalid));
      assert.equal(invalid.body.error, 'USAGE_INVALID_INPUT');
    }
    const deleted = await h.request(`/admin/api/usage/services/${encodeURIComponent(service.id)}`, admin, 'DELETE', body);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.id, service.id);
    assert(await h.repository.getService(h.service.id));
  } finally { await h.close(); }
});

test('service deletion: explicit authority, CAS, durable retry receipt and reserved old ID', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const user = await h.seedUser({ grant: false });
    const path = `/admin/api/usage/services/${h.service.id}`, body = { request_key: randomUUID(), expected_revision: 1 };
    assert.equal((await h.request(path, 'synthetic-auditor', 'DELETE', body)).status, 403);
    assert.equal((await h.request(path, admin, 'DELETE', { ...body, unexpected: true })).status, 400);
    assert.equal((await h.deletion(randomUUID(), 9)).body.error, 'USAGE_REVISION_CONFLICT');
    const deleted = await h.request(path, admin, 'DELETE', body);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.deleted, true); assert.equal(deleted.body.revision, 2);
    assert.equal(deleted.body.id, h.service.id); assert(deleted.body.deletedAt > 0);
    assert.deepEqual((await h.request(path, admin, 'DELETE', body)).body, deleted.body);
    assert.equal((await h.request(path, admin, 'DELETE', { ...body, expected_revision: 2 })).body.error, 'USAGE_IDEMPOTENCY_CONFLICT');
    assert.equal((await h.deletion()).body.error, 'USAGE_SERVICE_NOT_FOUND');
    assert.equal(await h.repository.getService(h.service.id), null);
    assert.deepEqual((await h.request('/admin/api/usage/services', admin)).body.items, []);
    await assert.rejects(h.repository.putService({ ...h.service, expectedRevision: 0 }), { code: 'USAGE_SERVICE_DELETED' });
    await assert.rejects(h.repository.putService({ ...h.service, expectedRevision: 2 }), { code: 'USAGE_SERVICE_DELETED' });
    const [rows] = await h.pool.query<any[]>('SELECT state,config_json FROM bz_usage_services WHERE id=?', [h.service.id]);
    assert.equal(rows[0].state, 'deleted'); assert.deepEqual(rows[0].config_json, h.service.config);
    const [sessions] = await h.pool.query<any[]>('SELECT state FROM bz_usage_sessions WHERE id=?', [user.actor.sessionId]);
    assert.equal(sessions[0].state, 'active'); assert.equal(h.state.calls, 0);
  } finally { await h.close(); }
});

for (const mode of ['ok', 'missing_usage'] as const) {
  test(`service deletion: ${mode} complete history survives exact GET and POST retry without redispatch`, { skip: !enabled }, async () => {
    const h = await fixture();
    try {
      const p = await h.plan(), user = await h.seedUser({ grant: false });
      await h.tokens.grant(user.accountId, { request_key: randomUUID(), plan_id: p.id, expected_revision: 0 });
      h.state.mode = mode;
      const input = { operation_id: randomUUID(), messages: [{ role: 'user', content: 'Synthetic' }] };
      let original = await h.request('/usage/v1/model/requests', user.token, 'POST', input);
      assert.equal(original.status, 200); assert.equal(original.body.result_state, 'complete');
      await h.tokens.drainSettlements();
      original = await h.request(`/usage/v1/model/requests/${input.operation_id}`, user.token);
      await h.tokens.putPlan({ id: p.id, label: p.label, config: p.config, expected_revision: 1, state: 'suspended' });
      await h.tokens.control(user.accountId, { request_key: randomUUID(), expected_revision: 1, state: 'suspended' });
      const [before] = await h.pool.query<any[]>('SELECT * FROM bz_usage_billing_ledger ORDER BY id');
      assert.equal((await h.deletion()).status, 200);
      const recovered = await h.request(`/usage/v1/model/requests/${input.operation_id}`, user.token);
      assert.equal(recovered.status, 200); assert.deepEqual(recovered.body, original.body);
      assert.deepEqual((await h.request('/usage/v1/model/requests', user.token, 'POST', input)).body, original.body);
      assert.equal(h.state.calls, 1);
      const [after] = await h.pool.query<any[]>('SELECT * FROM bz_usage_billing_ledger ORDER BY id');
      assert.deepEqual(after, before);
      assert.deepEqual((await h.request('/usage/v1/model/models', user.token)).body.items, []);
    } finally { await h.close(); }
  });
}
