import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUsageTestHarness } from './test-harness';
import { getBillingRepository } from './billing-repository';
import { billingAllowance } from './billing-ledger';
import { billingPeriod } from './billing-ledger';
import type { BillingPlanConfig } from './billing-contracts';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
test('customer allowance presentation uses persisted authority and all summary APIs agree', { skip: !enabled }, async t => {
  const h = await createUsageTestHarness(), tokens = getBillingRepository(h.repository);
  const config: BillingPlanConfig = { mode: 'credits', serviceIds: [h.service.id], priceUsd: 10_000, multiplier: 1, duration: { unit: 'month', count: 1 } };
  const dbNow = async () => Number((await h.pool.query<any[]>('SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS ms'))[0][0].ms);
  async function open(c = config, startsAt?: number) {
    const user = await h.seedUser({ grant: false }), id = randomUUID();
    await tokens.putPlan({ id, label: 'Synthetic allowance', expected_revision: 0, config: c });
    const grant = await tokens.grant(user.accountId, { request_key: id, plan_id: id, expected_revision: 0, ...(startsAt === undefined ? {} : { starts_at: startsAt }) });
    return { ...user, grant, planId: id };
  }
  async function allSummaries(user: { accountId: string; token: string }) {
    const results = await Promise.all([
      h.request('/usage/v1/model/summary', user.token),
      h.request(`/admin/api/usage/billing/accounts/${user.accountId}/summary`, 'synthetic-admin'),
      h.request(`/usage/v1/external/billing/accounts/${user.accountId}/summary`, h.issuerToken),
    ]);
    results.forEach(r => assert.equal(r.status, 200, JSON.stringify(r.body)));
    assert.deepEqual(results[0]!.body.presentation, results[1]!.body.presentation);
    assert.deepEqual(results[0]!.body.presentation, results[2]!.body.presentation);
    return results[0]!.body;
  }
  try {
    await t.test('no grant is unavailable, identity stays usable, removed display selector is rejected', async () => {
      const user = await h.seedUser({ grant: false }), summary = await allSummaries(user);
      assert.deepEqual(summary.presentation, { schema: 'bailing.usage-presentation.v1', kind: 'none', state: 'unavailable', remaining: null, total: null, displayValue: null });
      const bad = await h.request('/admin/api/usage/billing/plans', 'synthetic-admin', 'POST', { id: randomUUID(), label: 'Unsupported selector', expected_revision: 0, config: { ...config, displayUnit: 'tokens' } });
      assert.equal(bad.status, 400); assert.equal(h.state.calls, 0);
    });
    await t.test('credits reflect actual usage; pending billing does not erase balance; reads never debit or regrant', async () => {
      const user = await open(), operation = randomUUID();
      const result = await h.request('/usage/v1/model/requests', user.token, 'POST', { operation_id: operation, messages: [{ role: 'user', content: 'Synthetic' }] });
      assert.equal(result.body.billing_state, 'pending');
      await h.tokens.drainSettlements();
      const saved = await h.request(`/usage/v1/model/requests/${operation}`, user.token);
      assert.equal(saved.body.billed_usd, 25);
      let summary = await allSummaries(user);
      assert.deepEqual(summary.presentation, { schema: 'bailing.usage-presentation.v1', kind: 'credits', state: 'active', remaining: 9_975_000, total: 10_000_000, displayValue: '9975000' });
      h.state.mode = 'missing_usage';
      const pending = await h.request('/usage/v1/model/requests', user.token, 'POST', { operation_id: randomUUID(), messages: [{ role: 'user', content: 'Synthetic pending' }] });
      assert.equal(pending.body.result_state, 'complete'); assert.equal(pending.body.billing_state, 'pending'); h.state.mode = 'ok';
      summary = await allSummaries(user); assert.equal(summary.pendingRequests, 1); assert.equal(summary.presentation.displayValue, '9975000');
      for (let i = 0; i < 3; i++) await allSummaries(user);
      const [rows] = await h.pool.query<any[]>('SELECT (SELECT COUNT(*) FROM bz_usage_billing_grants WHERE account_id=?) AS grants,(SELECT COUNT(*) FROM bz_usage_billing_ledger WHERE account_id=?) AS ledger', [user.accountId,user.accountId]);
      assert.equal(Number(rows[0].grants), 1); assert.equal(Number(rows[0].ledger), 1);
      assert.equal(summary.grant.id, user.grant.id); assert.equal(summary.grant.revision, 1);
    });
    await t.test('template mode and conversion edits do not change an existing grant or its presentation', async () => {
      const user = await open();
      await tokens.putPlan({ id: user.planId, label: 'Periodic template', expected_revision: 1, config: { ...config, mode: 'periodic', periodAllowanceUsd: 123, periodUnit: 'week', multiplier: 7, priceUsd: 123 } });
      const summary = await allSummaries(user);
      assert.equal(summary.presentation.kind, 'credits'); assert.equal(summary.presentation.total, 10_000_000);
      assert.equal(summary.grant.id, user.grant.id); assert.equal(summary.grant.planRevision, 1); assert.equal(summary.grant.revision, 1);
      assert.deepEqual(summary.grant.config, billingAllowance(config));
    });
    await t.test('periodic projection uses current period only and clamps overage to depleted zero', async () => {
      const now = await dbNow(), startsAt = now - 86_400_000 - 1000;
      const user = await open({ ...config, mode: 'periodic', periodAllowanceUsd: 1000, periodUnit: 'day', priceUsd: 1000 }, startsAt);
      const period = billingPeriod(user.grant, now)!;
      await h.pool.execute('INSERT INTO bz_usage_billing_periods (grant_id,period_start,period_end,allowance_usd,consumed_usd) VALUES (?,?,?,?,?),(?,?,?,?,?)',
        [user.grant.id,startsAt,startsAt + 86_400_000,1000,1000,user.grant.id,period.start,period.end,1000,875]);
      let summary = await allSummaries(user);
      assert.equal(summary.consumedUsd, 1875); assert.equal(summary.currentPeriodConsumedUsd, 875);
      assert.deepEqual(summary.presentation, { schema: 'bailing.usage-presentation.v1', kind: 'percentage', state: 'active', remaining: 12.5, total: 100, displayValue: '12' });
      await h.pool.execute('UPDATE bz_usage_billing_periods SET consumed_usd=1005 WHERE grant_id=? AND period_start=?', [user.grant.id,period.start]);
      summary = await allSummaries(user); assert.equal(summary.presentation.state, 'depleted'); assert.equal(summary.presentation.remaining, 0); assert.equal(summary.presentation.displayValue, '0');
      assert.equal(summary.overageUsd, 5);
    });
    await t.test('future, expired and suspended state comes from persisted grant and account with DB time', async () => {
      const future = await open(config, await dbNow() + 60_000);
      assert.equal((await allSummaries(future)).presentation.state, 'not_started');
      const user = await open();
      await h.pool.execute('UPDATE bz_usage_billing_grants SET expires_at=? WHERE id=?', [await dbNow() - 1,user.grant.id]);
      let summary = await allSummaries(user); assert.equal(summary.presentation.state, 'expired'); assert.equal(summary.presentation.remaining, null); assert.equal(summary.presentation.displayValue, null);
      await h.pool.execute("UPDATE bz_usage_billing_grants SET state='suspended' WHERE id=?", [user.grant.id]);
      summary = await allSummaries(user); assert.equal(summary.presentation.state, 'suspended'); assert.equal(summary.presentation.remaining, null);
      const account = await open();
      await h.pool.execute("UPDATE bz_usage_accounts SET state='suspended' WHERE id=?", [account.accountId]);
      assert.equal((await h.request('/usage/v1/model/summary', account.token)).status, 403);
      const admin = await h.request(`/admin/api/usage/billing/accounts/${account.accountId}/summary`, 'synthetic-admin');
      const external = await h.request(`/usage/v1/external/billing/accounts/${account.accountId}/summary`, h.issuerToken);
      assert.equal(admin.body.presentation.state, 'suspended'); assert.equal(admin.body.presentation.remaining, null); assert.deepEqual(external.body.presentation, admin.body.presentation);
      assert.equal((await h.request('/usage/v1/model/summary?now=0', future.token)).status, 400);
    });
  } finally { await h.close(); }
});
