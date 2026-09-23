import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool, type RowDataPacket } from 'mysql2/promise';
import { UsageRepository, usageHash } from './repository';
import { getUsageIdentity } from './identity';
import { getBillingRepository } from './billing-repository';
import type { BillingPlanConfig } from './billing-contracts';
import type { UsageActor, UsageService } from './contracts';
const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
test('USD repository: shared allowance, soft overage, original settlement, lifetime and scope', { skip: !enabled }, async t => {
  const db = `token_repository_${randomUUID().replaceAll('-', '')}`;
  const settings = { host: '127.0.0.1', port: 16307, user: 'root', password: '', multipleStatements: true, connectionLimit: 12 };
  const admin = createPool(settings); await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  const pool = createPool({ ...settings, database: db }), repo = new UsageRepository(() => pool), identity = getUsageIdentity(repo), tokens = getBillingRepository(repo);
  try {
    assert.equal(await tokens.ready(), false);
    const migration = await readFile(new URL('../../../sql/063_usage_model_billing.sql', import.meta.url), 'utf8');
    await pool.query(migration); await pool.query(migration); assert.equal(await tokens.ready(), true);
    await t.test('fresh idempotent migration installs exactly the identity and USD schema', async () => {
      const [tables] = await pool.query<RowDataPacket[]>('SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE()');
      const expected = ['accounts','members','changes','services','issuers','users','sessions',
        'billing_plans','billing_grants','billing_heads','billing_periods','billing_requests','billing_ledger','price_snapshots'].map(name => `bz_usage_${name}`);
      assert.deepEqual(tables.map(row => row.name).sort(), expected.sort());
      const [columns] = await pool.query<RowDataPacket[]>("SELECT COLUMN_DEFAULT AS defaultValue,IS_NULLABLE AS nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='bz_usage_sessions' AND column_name='model_access'");
      assert.equal(columns.length, 1); assert.equal(columns[0]!.defaultValue, 'service'); assert.equal(columns[0]!.nullable, 'NO');
      assert.equal(await identity.ready(), true);
    });
    const services: UsageService[] = [];
    for (const id of ['alpha','beta','outside']) services.push(await repo.putService({ id, label: `Synthetic ${id}`, expectedRevision: 0,
      config: { credential: 'synthetic', model: `model-${id}`, providerScope: `synthetic-${id}`, maxInputBytes: 100000, maxOutputTokens: 1000, timeoutMs: 3000 } }));
    const issuer = await identity.createIssuer({ id: 'synthetic-issuer', label: 'Synthetic issuer', permissions: ['identity:exchange','identity:revoke','usage:read'], service_ids: ['alpha','beta'] });
    const config: BillingPlanConfig = { mode: 'credits', serviceIds: ['alpha','beta'], priceUsd: 100, duration: { unit: 'day', count: 30 }, multiplier: 1 };
    const plan = await tokens.putPlan({ id: 'synthetic-plan', label: 'Synthetic allowance', expected_revision: 0, config });
    async function user(modelAccess: 'service' | 'token_gateway' = 'token_gateway', planId = plan.id, startsAt?: number) {
      const out = await identity.exchange(issuer.credential!, { request_key: randomUUID(), tenant: 'synthetic', subject: randomUUID(), service_id: 'alpha', ...(modelAccess === 'token_gateway' ? { model_access: modelAccess } : {}) });
      const grant = await tokens.grant(out.session.accountId, { request_key: randomUUID(), plan_id: planId, expected_revision: 0, ...(startsAt === undefined ? {} : { starts_at: startsAt }) });
      return { actor: out.session, grant };
    }
    async function admit(actor: UsageActor, serviceId = 'alpha', operationId: string = randomUUID()) {
      const svc = services.find(s => s.id === serviceId)!;
      return tokens.admit({ actor, operationId, serviceId, conversationId: null, turnId: null, requestHash: usageHash([operationId, serviceId]), expectedServiceRevision: svc.revision, serviceConfig: svc.config, model: svc.config.model, priceSnapshot: { source: 'openrouter', currency: 'USD', modelId: 'synthetic', endpointId: 'synthetic', fetchedAt: Date.now(), lines: [{ billable: 'prompt', unit: 'token', costUsd: '1' }, { billable: 'completion', unit: 'token', costUsd: '1' }] } });
    }
    const response = { choices: [{ message: { role: 'assistant', content: 'Synthetic result' } }] };
    await t.test('multiple models share Token pool; finish admitted response and block next; replay exact evidence', async () => {
      const { actor } = await user();
      const a = await admit(actor), b = await admit(actor, 'beta');
      const [pa,pb] = await Promise.all([tokens.commitDispatch(a.id, actor), tokens.commitDispatch(b.id, actor)]);
      await assert.rejects(tokens.commitDispatch(a.id, actor), { code: 'USAGE_PENDING' });
      await tokens.complete(a.id, pa.fence!, { response, usage: { inputTokens: 20, outputTokens: 40 } });
      const receipt = { response, usage: { inputTokens: 30, outputTokens: 40 }, executionId: 'synthetic-unique' };
      const settled = await tokens.complete(b.id, pb.fence!, receipt);
      assert.equal(settled.billedUsd, 70); assert.equal(settled.overageUsd, 30);
      assert.equal((await tokens.complete(b.id, pb.fence!, receipt)).revision, settled.revision);
      const summary = await tokens.summary(actor.accountId);
      assert.equal(summary.availableUsd, 0); assert.equal(summary.consumedUsd, 130); assert.equal(summary.overageUsd, 30);
      await assert.rejects(admit(actor), { code: 'ALLOWANCE_INSUFFICIENT' });
      const duplicate = await admit(actor, 'beta', b.operationId); assert.equal(duplicate.created, false);
      await assert.rejects(tokens.complete(b.id, pb.fence!, { response, usage: { inputTokens: 1, outputTokens: 1 } }), { code: 'USAGE_RECEIPT_CONFLICT' });
      await assert.rejects(tokens.complete(b.id, pb.fence!, { ...receipt, executionId: 'different-execution' }), { code: 'USAGE_RECEIPT_CONFLICT' });
      const view = tokens.view(settled); assert.equal('serviceConfig' in view, false); assert.equal('fence' in view, false); assert.deepEqual(view.response, response);
      assert.equal('response' in tokens.view(settled, settled.createdAt + 8 * 86_400_000), false);
    });
    await t.test('result complete without usage remains usable; delayed usage settles once, unknown never redispatches', async () => {
      const { actor } = await user(), a = await admit(actor), p = await tokens.commitDispatch(a.id, actor);
      const completed = await tokens.complete(a.id, p.fence!, { response });
      assert.equal(completed.resultState, 'complete'); assert.equal(completed.billingState, 'pending');
      assert.deepEqual(tokens.view(completed).response, response); assert.equal((await tokens.summary(actor.accountId)).pendingRequests, 1);
      const finished = await tokens.complete(a.id, p.fence!, { response, usage: { inputTokens: 12, outputTokens: 3 } });
      assert.equal(finished.billingState, 'settled');
      const b = await admit(actor), q = await tokens.commitDispatch(b.id, actor);
      await tokens.markUnknown(b.id, q.fence!, 'connection_lost');
      assert.equal((await tokens.findRequest(actor, b.operationId))!.resultState, 'unknown');
      assert.equal((await admit(actor, 'alpha', b.operationId)).created, false);
      await assert.rejects(tokens.commitDispatch(b.id, actor), { code: 'USAGE_PENDING' });
      await tokens.complete(b.id, q.fence!, { response, usage: { inputTokens: 4, outputTokens: 1 } });
      assert.equal((await tokens.summary(actor.accountId)).consumedUsd, 20);
    });
    await t.test('plan CAS and grant snapshots preserve old requests and late settlement across replacement', async () => {
      const { actor, grant } = await user(), a = await admit(actor), p = await tokens.commitDispatch(a.id, actor);
      const edited = await tokens.putPlan({ id: plan.id, label: 'Edited template', expected_revision: plan.revision, config: { ...config, priceUsd: 300 } });
      assert.equal((await tokens.summary(actor.accountId)).grant!.config.priceUsd, 100);
      await assert.rejects(tokens.putPlan({ id: plan.id, label: 'Stale', expected_revision: 1, config }), { code: 'USAGE_REVISION_CONFLICT' });
      const requestKey = randomUUID(), body = { request_key: requestKey, plan_id: edited.id, expected_revision: grant.revision };
      const replacement = await tokens.grant(actor.accountId, body);
      assert.equal((await tokens.grant(actor.accountId, body)).id, replacement.id);
      await assert.rejects(tokens.grant(actor.accountId, { ...body, plan_id: 'other' }), { code: 'USAGE_IDEMPOTENCY_CONFLICT' });
      await tokens.complete(a.id, p.fence!, { response, usage: { inputTokens: 20, outputTokens: 10 } });
      assert.equal((await tokens.summary(actor.accountId)).availableUsd, 300);
      const [old] = await pool.query<RowDataPacket[]>('SELECT consumed_usd FROM bz_usage_billing_periods WHERE grant_id=?', [grant.id]);
      assert.equal(Number(old[0]!.consumed_usd), 30);
      await assert.rejects(tokens.control(actor.accountId, { request_key: randomUUID(), expected_revision: replacement.revision, state: 'suspended' }, 'external'), { code: 'USAGE_SOURCE_CONFLICT' });
      const before = await admit(actor);
      await tokens.control(actor.accountId, { request_key: randomUUID(), expected_revision: replacement.revision, state: 'suspended' });
      await assert.rejects(tokens.commitDispatch(before.id, actor), { code: 'SERVICE_NOT_ENTITLED' });
      assert.equal((await tokens.findRequest(actor, a.operationId))!.billedUsd, 30);
    });
    await t.test('settlement storage failure preserves usable reply and original-request reconciliation', async () => {
      const { actor } = await user(), a = await admit(actor), p = await tokens.commitDispatch(a.id, actor);
      const transact = repo.withTransaction.bind(repo); let calls = 0;
      repo.withTransaction = async fn => { calls++; if (calls === 2) throw new Error('synthetic_settlement_storage_unavailable'); return transact(fn); };
      let pending;
      try { pending = await tokens.complete(a.id, p.fence!, { response, usage: { inputTokens: 20, outputTokens: 10 } }); }
      finally { repo.withTransaction = transact; }
      assert.equal(calls, 2); assert.equal(pending.billingState, 'pending'); assert.equal(pending.resultState, 'complete'); assert.deepEqual(tokens.view(pending).response, response);
      const [before] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM bz_usage_billing_ledger WHERE request_id=?', [a.id]); assert.equal(Number(before[0]!.n), 0);
      await tokens.reconcilePendingUsage();
      const [reconciled] = await pool.query<RowDataPacket[]>('SELECT billing_state FROM bz_usage_billing_requests WHERE id=?', [a.id]); assert.equal(reconciled[0]!.billing_state, 'settled');
      const restored = await tokens.findRequest(actor, a.operationId); assert.equal(restored!.billingState, 'settled'); assert.equal(restored!.billedUsd, 30);
      await tokens.findRequest(actor, a.operationId);
      const [after] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM bz_usage_billing_ledger WHERE request_id=?', [a.id]); assert.equal(Number(after[0]!.n), 1);
    });
    await t.test('cancel before dispatch costs zero; late canceled completion settles but cannot return executable tools', async () => {
      const { actor } = await user(), a = await admit(actor);
      assert.equal((await tokens.cancel(actor, a.operationId)).billedUsd, 0);
      await assert.rejects(tokens.commitDispatch(a.id, actor), { code: 'USAGE_PENDING' });
      const b = await admit(actor), p = await tokens.commitDispatch(b.id, actor);
      await tokens.cancel(actor, b.operationId);
      const late = await tokens.complete(b.id, p.fence!, { response: { tool_calls: [{ id: 'never-execute' }] }, usage: { inputTokens: 8, outputTokens: 2 } });
      assert.equal(late.state, 'cancelled'); assert.equal(late.billingState, 'settled'); assert.equal('response' in tokens.view(late), false);
      assert.equal((await tokens.summary(actor.accountId)).consumedUsd, 10);
    });
    await t.test('service/issuer scope, member revocation and template service changes are checked again at dispatch', async () => {
      const old = await user('service'); await assert.rejects(admit(old.actor, 'beta'), { code: 'USAGE_ACCOUNT_FORBIDDEN' });
      const { actor } = await user(); await assert.rejects(admit(actor, 'outside'), { code: 'SERVICE_NOT_ENTITLED' });
      const a = await admit(actor);
      await pool.query("UPDATE bz_usage_members SET state='revoked' WHERE account_id=? AND user_id=?", [actor.accountId, actor.userId]);
      await assert.rejects(tokens.commitDispatch(a.id, actor), { code: 'USAGE_ACCOUNT_FORBIDDEN' });
      const fresh = await user(), b = await admit(fresh.actor);
      await pool.query("UPDATE bz_usage_services SET state='suspended',revision=revision+1 WHERE id='alpha'");
      await assert.rejects(tokens.commitDispatch(b.id, fresh.actor), { code: 'USAGE_REVISION_CONFLICT' });
      await pool.query("UPDATE bz_usage_services SET state='active',revision=1 WHERE id='alpha'");
    });
    await t.test('late usage belongs to original anchored period; current period is fresh, expiry stops admission', async () => {
      await tokens.putPlan({ id: 'daily', label: 'Synthetic daily', expected_revision: 0, config: { ...config, mode: 'periodic', periodAllowanceUsd: 100, periodUnit: 'day', duration: { unit: 'day', count: 3 } } });
      const dbNow = async () => Number((await pool.query<RowDataPacket[]>('SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS ms'))[0][0]!.ms);
      const { actor, grant } = await user('token_gateway', 'daily', await dbNow() - 86_400_000 + 1200);
      const a = await admit(actor), p = await tokens.commitDispatch(a.id, actor);
      await new Promise(resolve => setTimeout(resolve, 1250));
      await tokens.complete(a.id, p.fence!, { response, usage: { inputTokens: 110, outputTokens: 20 } });
      const summary = await tokens.summary(actor.accountId);
      assert.equal(summary.currentPeriodConsumedUsd, 0); assert.equal(summary.availableUsd, 100); assert.equal(summary.consumedUsd, 130);
      const b = await admit(actor); assert.notEqual(b.periodStart, a.periodStart);
      await pool.query('UPDATE bz_usage_billing_grants SET expires_at=? WHERE id=?', [await dbNow() - 1, grant.id]);
      const expired = await tokens.summary(actor.accountId);
      assert.equal(expired.availableUsd, 0); assert.equal(expired.presentation.state, 'expired'); assert.equal(expired.presentation.remaining, null);
    });
    await t.test('same optional coordinates support more than 256 model requests without a turn record', async () => {
      const { actor } = await user();
      for (let index = 0; index < 260; index++) {
        const a = await admit(actor), p = await tokens.commitDispatch(a.id, actor);
        await tokens.complete(a.id, p.fence!, { response, usage: { inputTokens: 0, outputTokens: 0 } });
      }
      assert.equal((await tokens.summary(actor.accountId)).consumedUsd, 0);
      const page = await tokens.listRequests(actor.accountId, { limit: 25 }); assert.equal(page.items.length, 25); assert.ok(page.next_cursor);
      const next = await tokens.listRequests(actor.accountId, { limit: 25, cursor: page.next_cursor });
      assert.equal(new Set([...page.items,...next.items].map(x => x.operation_id)).size, 50);
      const [tables] = await pool.query<RowDataPacket[]>('SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE()');
      assert.equal(tables.length, 14, 'Only identity/account/model and USD accounting tables are installed.');
    });
    await t.test('supplier execution cannot settle two requests; expired reply body is purged without losing audit identity', async () => {
      const { actor } = await user(), a = await admit(actor), b = await admit(actor);
      const pa = await tokens.commitDispatch(a.id, actor), pb = await tokens.commitDispatch(b.id, actor);
      const receipt = { response, usage: { inputTokens: 5, outputTokens: 5 }, executionId: 'unique-supplier-receipt' };
      await tokens.complete(a.id, pa.fence!, receipt);
      await assert.rejects(tokens.complete(b.id, pb.fence!, receipt), { code: 'USAGE_RECEIPT_CONFLICT' });
      const oldTime = Date.now() - 8 * 86_400_000;
      await pool.query('UPDATE bz_usage_billing_requests SET created_at=? WHERE id=?', [oldTime, a.id]);
      await tokens.cleanupExpiredResponses();
      const restored = (await tokens.findRequest(actor, a.operationId))!;
      assert.equal(restored.response, null); assert.equal(restored.billedUsd, 10); assert.ok(restored.resultHash);
      const publicView = tokens.view(restored); assert.equal(publicView.response_expired, true); assert.equal(publicView.dispatch, 'completed');
      assert.equal('response' in publicView, false); assert.equal('resultHash' in publicView, false);
      const other = await user(); assert.equal(await tokens.findRequest(other.actor, a.operationId), null);
      await assert.rejects(tokens.listRequests(other.actor.accountId, { cursor: a.id }), { code: 'USAGE_INVALID_INPUT' });
    });
  } finally {
    await pool.end(); await admin.query(`DROP DATABASE \`${db}\``); await admin.end();
  }
});
