import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UsageIssuerClient, UsageIssuerError } from '../../../sdk/node/src/usage.mjs';
import type { BillingPlan, BillingGrant, BillingSummary } from './billing-contracts';
import { createUsageTestHarness } from './test-harness';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
const sdkError = (code: string) => (error: unknown) => error instanceof UsageIssuerError
  && error.code === code && error.outcome === 'rejected';
function runPhp(fixture: Record<string, string>): Promise<{ accountId: string; grantId: string; revision: number; checks: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.BAILING_SDK_PHP7_BINARY || 'php', [fileURLToPath(new URL('../../../sdk/php7/tests/billing-core-http.php', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) { reject(new Error(`Synthetic PHP Core acceptance failed (${code}): ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid synthetic PHP acceptance receipt')); }
    });
    child.stdin.end(JSON.stringify(fixture));
  });
}

test('business issuer SDKs use the Core USD billing HTTP contract without invoking models', { skip: !enabled, timeout: 60_000 }, async t => {
  const h = await createUsageTestHarness();
  try {
    const periodPlanId = randomUUID(), creditsPlanId = randomUUID();
    await h.tokens.putPlan({ id: periodPlanId, label: 'Synthetic monthly', expected_revision: 0, config: {
      mode: 'periodic', priceUsd: 300, periodAllowanceUsd: 100, periodUnit: 'month', multiplier: 1.5,
      serviceIds: [h.service.id], duration: { unit: 'month', count: 3 },
    } });
    await h.tokens.putPlan({ id: creditsPlanId, label: 'Synthetic credits', expected_revision: 0, config: {
      mode: 'credits', priceUsd: 12, multiplier: 1, serviceIds: [h.service.id], duration: { unit: 'forever', count: 1 },
    } });
    const outsider = await h.identity.createIssuer({ id: 'synthetic-outsider', label: 'Synthetic outsider', permissions: ['usage:read'], service_ids: [h.service.id] });
    const client = new UsageIssuerClient({ baseUrl: h.baseUrl, issuerToken: h.issuerToken });
    await t.test('Node: identity, catalog, period allowance, exact replay, control, credits and ownership', async () => {
      const identity = { tenant: 'synthetic-sdk', subject: randomUUID() };
      const loginInput = { ...identity, request_key: randomUUID(), service_id: h.service.id, model_access: 'token_gateway' as const };
      const login = await client.exchangeSession(loginInput), accountId = login.session.accountId;
      assert.equal(login.schema, 'bailing.usage-session.v1'); assert.equal(login.session.modelAccess, 'token_gateway');
      assert.deepEqual(await client.exchangeSession(loginInput), login);
      // These assignments also ensure the packaged SDK response types match the Core contract.
      const plans: BillingPlan[] = (await client.listBillingPlans()).items;
      assert.equal(plans.length, 2);
      assert.equal(plans.find(plan => plan.id === periodPlanId)?.config.periodAllowanceUsd, 100);
      assert.equal(plans.find(plan => plan.id === periodPlanId)?.config.priceUsd, 300);
      assert.equal(plans.find(plan => plan.id === creditsPlanId)?.config.periodAllowanceUsd, undefined);
      assert.equal((await client.getBillingSummary(accountId)).grant, null);
      const grantInput = { request_key: 'grant-period', plan_id: periodPlanId, expected_revision: 0 };
      const grant: BillingGrant = await client.grantBillingPlan(accountId, grantInput);
      assert.deepEqual(await client.grantBillingPlan(accountId, grantInput), grant);
      assert.equal(grant.sourceOwner, 'issuer:synthetic-product');
      const summary: BillingSummary = await client.getBillingSummary(accountId);
      assert.equal(summary.schema, 'bailing.billing-summary.v1'); assert.equal(summary.availableUsd, 100);
      assert.equal(summary.consumedUsd, 0); assert.equal(summary.presentation.kind, 'percentage');
      assert.equal(summary.presentation.remaining, 100); assert.equal(summary.plan?.multiplier, 1.5);
      await assert.rejects(client.grantBillingPlan(accountId, { ...grantInput, expected_revision: 1 }), sdkError('USAGE_IDEMPOTENCY_CONFLICT'));
      await assert.rejects(client.grantBillingPlan(accountId, { ...grantInput, request_key: 'stale-grant' }), sdkError('USAGE_REVISION_CONFLICT'));
      const pauseInput = { request_key: 'pause-period', expected_revision: 1, state: 'suspended' as const };
      const paused = await client.controlBillingPlan(accountId, pauseInput);
      assert.equal(paused.revision, 2); assert.deepEqual(await client.controlBillingPlan(accountId, pauseInput), paused);
      assert.equal((await client.getBillingSummary(accountId)).presentation.state, 'suspended');
      const credits = await client.grantBillingPlan(accountId, { request_key: 'grant-credits', plan_id: creditsPlanId, expected_revision: 2 });
      assert.equal(credits.revision, 3);
      const current = await client.getBillingSummary(accountId);
      assert.equal(current.availableUsd, 12); assert.equal(current.presentation.displayValue, '12000');
      const foreign = new UsageIssuerClient({ baseUrl: h.baseUrl, issuerToken: outsider.credential! });
      await assert.rejects(foreign.getBillingSummary(accountId), sdkError('USAGE_ACCOUNT_FORBIDDEN'));
      await assert.rejects(foreign.grantBillingPlan(accountId, grantInput), sdkError('USAGE_FORBIDDEN'));
      assert.deepEqual(await client.revokeUser(identity), { revoked: true });
      assert.deepEqual(await client.revokeUser(identity), { revoked: true });
      await assert.rejects(client.exchangeSession({ ...loginInput, request_key: 'after-revoke' }), sdkError('USAGE_ACCOUNT_SUSPENDED'));
      const [rows] = await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_billing_grants WHERE account_id=?', [accountId]);
      assert.equal(Number(rows[0].n), 2);
    });
    await t.test('PHP7: default HTTP transport uses the same Core routes and dollar allowance contract', async () => {
      const result = await runPhp({ baseUrl: h.baseUrl, issuerToken: h.issuerToken, outsiderToken: outsider.credential!,
        subject: randomUUID(), serviceId: h.service.id, periodPlanId, creditsPlanId });
      assert.equal(result.checks, 'passed'); assert.equal(result.revision, 3);
      const [rows] = await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_billing_grants WHERE account_id=?', [result.accountId]);
      assert.equal(Number(rows[0].n), 2);
      const summary = await h.tokens.summary(result.accountId);
      assert.equal(summary.grant?.id, result.grantId);
    });
    assert.equal(h.state.calls, 0); assert.equal(h.state.counts, 0);
  } finally { await h.close(); }
});
