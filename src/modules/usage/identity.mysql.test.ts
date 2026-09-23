import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUsageTestHarness } from './test-harness';
import type { PriceSnapshot } from './billing-contracts';
import { getBillingRepository } from './billing-repository';
import { usageHash } from './repository';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
test('usage identity and management: exact source mapping, billed model request recovery and source ownership', { skip: !enabled }, async t => {
  const h = await createUsageTestHarness();
  const exchange = (subject: string, tenant = 'same', extra: Record<string, unknown> = {}) => h.request('/usage/v1/sessions/exchange', h.issuerToken, 'POST', { request_key: randomUUID(), tenant, subject, service_id: h.service.id, ...extra });
  try {
    await t.test('tenant, source, case and generation do not merge accounts; oversized identities are rejected', async () => {
      const a = await exchange('User42'), b = await exchange('user42'), c = await exchange('User42', 'other'), d = await exchange('User42', 'same', { generation: 'new-person' });
      for (const result of [a,b,c,d]) assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(new Set([a,b,c,d].map(r => r.body.session.accountId)).size, 4);
      const same = await exchange('User42'); assert.equal(same.body.session.accountId, a.body.session.accountId);
      assert.equal((await exchange('a'.repeat(129))).status, 400);
      assert.equal((await exchange(' User42')).status, 400);
      const foreign = await h.identity.createIssuer({ id: 'different-issuer', label: 'Other product', permissions: ['identity:exchange'], service_ids: [h.service.id] });
      const foreignUser = await h.request('/usage/v1/sessions/exchange', foreign.credential!, 'POST', { request_key: randomUUID(), tenant: 'same', subject: 'User42', service_id: h.service.id });
      assert.notEqual(foreignUser.body.session.accountId, a.body.session.accountId);
    });
    await t.test('ill-formed Unicode never reaches identity persistence; valid emoji stays exact', async () => {
      const count = async () => { const [rows] = await h.pool.query<any[]>('SELECT (SELECT COUNT(*) FROM bz_usage_users) AS users,(SELECT COUNT(*) FROM bz_usage_accounts) AS accounts'); return rows[0]; };
      const before = await count();
      for (const invalid of ['\uD800','\uD801','\uDC00','a\uD800b']) {
        assert.equal((await exchange(invalid)).status, 400);
        assert.equal((await exchange('valid-user', invalid)).status, 400);
        assert.equal((await exchange('valid-user', 'same', { generation: invalid })).status, 400);
      }
      assert.deepEqual(await count(), before);
      const emoji = await exchange('user-😀'), same = await exchange('user-😀'), other = await exchange('user-😃');
      assert.equal(emoji.status, 200); assert.equal(same.body.session.userId, emoji.body.session.userId);
      assert.notEqual(other.body.session.userId, emoji.body.session.userId);
    });
    await t.test('exchange retries retain original credential/account; altered body cannot hijack request key', async () => {
      const input = { request_key: randomUUID(), tenant: '', subject: 'repeat-user', service_id: h.service.id };
      const first = await h.request('/usage/v1/sessions/exchange', h.issuerToken, 'POST', input);
      const second = await h.request('/usage/v1/sessions/exchange', h.issuerToken, 'POST', input);
      assert.equal(first.status, 200); assert.deepEqual(second.body, first.body);
      const explicitScope = await h.request('/usage/v1/sessions/exchange', h.issuerToken, 'POST', { ...input, model_access: 'service' });
      assert.equal(explicitScope.status, 200); assert.deepEqual(explicitScope.body, first.body);
      assert.equal(first.body.session.modelAccess, 'service');
      assert.equal((await h.request('/usage/v1/sessions/exchange', h.issuerToken, 'POST', { ...input, model_access: 'token_gateway' })).status, 409);
      assert.equal((await exchange('invalid-scope', 'same', { model_access: 'all' })).status, 400);
      assert.equal((await h.request('/usage/v1/sessions/exchange', h.issuerToken, 'POST', { ...input, subject: 'other-user' })).status, 409);
      const [rows] = await h.pool.query<any[]>('SELECT token_hash FROM bz_usage_sessions WHERE id=?', [first.body.session.sessionId]);
      assert.match(rows[0].token_hash, /^[a-f0-9]{64}$/); assert.notEqual(rows[0].token_hash, first.body.credential);
    });
    await t.test('renewed identity reads original billed model request; summary cannot select another account', async () => {
      const user = await h.seedUser(), tokens = getBillingRepository(h.repository);
      const priceSnapshot: PriceSnapshot = {source:'openrouter',modelId:'synthetic/model',endpointId:'synthetic-endpoint',currency:'USD',fetchedAt:Date.now(),lines:[{billable:'prompt',unit:'token',costUsd:'1'},{billable:'completion',unit:'token',costUsd:'1'}]};
      const input = { priceSnapshot, actor: user.actor, operationId: randomUUID(), serviceId: h.service.id, conversationId: 'original-conversation', turnId: null,
        requestHash: usageHash(randomUUID()), expectedServiceRevision: h.service.revision, serviceConfig: h.service.config, model: h.service.config.model };
      const original = await tokens.admit(input), dispatched = await tokens.commitDispatch(original.id, user.actor);
      await tokens.complete(original.id, dispatched.fence!, { response: { text: 'Synthetic original reply' }, usage: { inputTokens: 20, outputTokens: 5 } });
      const renewed = await exchange(user.subject, 'synthetic');
      assert.equal(renewed.body.session.accountId, user.accountId); assert.notEqual(renewed.body.session.sessionId, user.actor.sessionId);
      const read = await tokens.findRequest(renewed.body.session, original.operationId);
      assert.equal(read!.conversationId, 'original-conversation'); assert.equal(read!.billedUsd, 25);
      assert.equal((await h.request('/usage/v1/model/summary?account_id=other', renewed.body.credential)).status, 400);
      assert.equal((await h.request('/usage/v1/model/summary', renewed.body.credential)).status, 200);
    });
    await t.test('user and issuer revocation deny subsequent use without modifying business authorizations', async () => {
      const user = await h.seedUser();
      assert.equal((await h.request('/usage/v1/external/users/revoke', h.issuerToken, 'POST', { tenant: 'synthetic', subject: user.subject })).status, 200);
      assert.equal((await h.request('/usage/v1/model/summary', user.token)).status, 401);
      assert.equal((await exchange(user.subject, 'synthetic')).status, 403);
      const other = await h.seedUser();
      assert.equal((await h.request('/usage/v1/sessions/revoke', other.token, 'POST', {})).status, 200);
      assert.equal((await h.request('/usage/v1/model/summary', other.token)).status, 401);
    });
    await t.test('USD template CAS, validation and Console authority remain explicit', async () => {
      const user = await h.seedUser(), tokens = getBillingRepository(h.repository), config = (await tokens.summary(user.accountId)).grant!.config;
      const plan = { id: 'simple-billing-plan', label: 'Simple USD allowance', expected_revision: 0, config: {...config, multiplier: 1, serviceIds: [h.service.id]} };
      const saved = await h.request('/admin/api/usage/billing/plans', 'synthetic-admin', 'POST', plan); assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal((await h.request('/admin/api/usage/billing/plans', 'synthetic-admin', 'POST', plan)).status, 409);
      assert.equal((await h.request('/admin/api/usage/billing/plans', 'synthetic-admin', 'POST', { ...plan, id: 'arbitrary-plan', config: { ...config, seat_price: 100 } })).status, 400);
      assert.equal((await h.request('/admin/api/usage/issuers', 'synthetic-auditor')).status, 403);
      assert.equal((await h.request('/admin/api/usage/accounts', 'synthetic-auditor')).status, 200);
      assert.equal((await h.request('/admin/api/usage/accounts', 'synthetic-admin', 'POST', { request_key: randomUUID(), source_id: randomUUID(), kind: 'organization', label: 'Unmapped administrator', user_id: 'admin' })).status, 404);
    });
    await t.test('lost configuration ACK requires current-state reconciliation and never rotates twice', async () => {
      const admin = 'synthetic-admin', service = { id: 'cas-service', label: 'CAS service', expected_revision: 0, config: h.service.config };
      assert.equal((await h.request('/admin/api/usage/services', admin, 'POST', service)).status, 200);
      assert.equal((await h.request('/admin/api/usage/services', admin, 'POST', service)).body.code, 'USAGE_REVISION_CONFLICT');
      assert.equal((await h.repository.getService(service.id))!.revision, 1);
      const input = { id: 'rotate-source', label: 'Rotate source', permissions: ['identity:exchange'], service_ids: [h.service.id] };
      const created = await h.request('/admin/api/usage/issuers', admin, 'POST', input); assert.equal(created.status, 200);
      const reread = await h.request('/admin/api/usage/issuers', admin, 'POST', input); assert.equal(reread.body.created, false); assert.equal(reread.body.credential, null);
      const body = { expected_revision: 1, state: 'active', rotate: true }, path = `/admin/api/usage/issuers/${input.id}/control`;
      const rotated = await h.request(path, admin, 'POST', body); assert.equal(rotated.status, 200);
      assert.equal((await h.request(path, admin, 'POST', body)).body.code, 'USAGE_REVISION_CONFLICT');
      const sources = await h.identity.listIssuers(); assert.equal(sources.find(source => source.id === input.id)!.revision, 2);
      await assert.rejects(h.identity.authenticateIssuer(created.body.credential, 'identity:exchange'));
      assert.equal((await h.identity.authenticateIssuer(rotated.body.credential, 'identity:exchange')).id, input.id);
    });
    await t.test('another allowance source cannot be silently overwritten by the Hub Console', async () => {
      const existing = await h.seedUser(), tokens = getBillingRepository(h.repository), template = (await tokens.summary(existing.accountId)).grant!;
      const fresh = await exchange(randomUUID(), 'synthetic'), accountId = fresh.body.session.accountId;
      const external = await tokens.grant(accountId, { request_key: randomUUID(), plan_id: template.planId, expected_revision: 0 }, 'issuer:synthetic-product');
      await assert.rejects(tokens.grant(accountId, { request_key: randomUUID(), plan_id: template.planId, expected_revision: external.revision }), { code: 'USAGE_SOURCE_CONFLICT' });
      await assert.rejects(tokens.control(accountId, { request_key: randomUUID(), expected_revision: external.revision, state: 'suspended' }), { code: 'USAGE_SOURCE_CONFLICT' });
      const controlled = await tokens.control(accountId, { request_key: randomUUID(), expected_revision: external.revision, state: 'suspended' }, 'issuer:synthetic-product');
      assert.equal(controlled.state, 'suspended');
    });
    await t.test('identity readiness requires model scope and never repairs missing schema implicitly', async () => {
      assert.equal(await h.identity.ready(), true);
      await h.pool.query('ALTER TABLE bz_usage_sessions RENAME COLUMN model_access TO missing_model_access');
      assert.equal(await h.identity.ready(), false);
      await h.pool.query('ALTER TABLE bz_usage_sessions RENAME COLUMN missing_model_access TO model_access');
      assert.equal(await h.identity.ready(), true);
      const user = await h.seedUser();
      await h.pool.query("UPDATE bz_usage_sessions SET model_access='invalid' WHERE id=?", [user.actor.sessionId]);
      await assert.rejects(h.identity.authenticate(user.token), { code: 'USAGE_ACCOUNT_FORBIDDEN' });
    });
  } finally { await h.close(); }
});
