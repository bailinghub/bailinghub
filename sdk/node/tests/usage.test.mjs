import assert from 'node:assert/strict';
import test from 'node:test';
import { UsageIssuerClient, UsageIssuerError } from '../src/index.mjs';
const issuerToken = `bhu_i_${'x'.repeat(43)}`;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const input = { request_key: 'order-1', plan_id: 'plan-1', expected_revision: 0 };
test('Billing issuer methods preserve scope and exact grant keys', async () => {
  const calls = [];
  const sdk = new UsageIssuerClient({ baseUrl: 'https://hub.example.com', issuerToken, fetchImpl: async (url, init) => {
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${issuerToken}`);
    calls.push({ path: new URL(url).pathname, method: init.method, body: init.body && JSON.parse(init.body) }); return json({ ok: true });
  } });
  await sdk.exchangeSession({ request_key: 'login-1', tenant: 'tenant-1', subject: 'subject-1', service_id: 'text' });
  await sdk.grantBillingPlan('account-1', input); await sdk.grantBillingPlan('account-1', input);
  await sdk.controlBillingPlan('account-1', { request_key: 'pause-1', expected_revision: 1, state: 'suspended' });
  await sdk.getBillingSummary('account-1'); await sdk.revokeUser({ tenant: 'tenant-1', subject: 'subject-1' }); await sdk.listBillingPlans();
  assert.equal(calls.length, 7); assert.deepEqual(calls[1], calls[2]);
  assert.equal(calls[1].path, '/usage/v1/external/billing/accounts/account-1/grant');
  assert.equal(calls[4].path, '/usage/v1/external/billing/accounts/account-1/summary');
  assert.equal(calls[6].path, '/usage/v1/external/billing/plans');
  for (const removed of ['listTokenPlans','grantTokenPlan','controlTokenPlan','getTokenSummary','getSummary','grantCredits','putEntitlement','renewEntitlement','listLedger','listPlans']) assert.equal(sdk[removed], undefined);
  assert.equal(JSON.stringify(sdk).includes(issuerToken), false);
});
test('grant acknowledgement loss preserves original wire input and only caller retry sends it again', async () => {
  const original = { request_key: 'grant-1', expected_revision: 2, plan_id: 'plan-1' };
  const bodies = [];
  const sdk = new UsageIssuerClient({ baseUrl: 'https://hub.example.com', issuerToken, fetchImpl: async (url, init) => {
    assert.ok(url.endsWith('/grant')); assert.equal(init.method, 'POST'); bodies.push(init.body);
    if (bodies.length === 1) throw new Error('lost acknowledgement'); return json({ revision: 3 });
  } });
  await assert.rejects(sdk.grantBillingPlan('account-1', original), error => {
    assert.equal(error.outcome, 'unknown'); assert.equal(error.requestKey, 'grant-1'); return true;
  });
  assert.equal(bodies.length, 1);
  assert.equal((await sdk.grantBillingPlan('account-1', original)).revision, 3);
  assert.deepEqual(JSON.parse(bodies[0]), original); assert.equal(bodies[0], bodies[1]);
});
test('issuer transport never auto-retries ambiguous mutation or exposes private cause', async () => {
  let calls = 0;
  const sdk = new UsageIssuerClient({ baseUrl: 'https://hub.example.com', issuerToken, fetchImpl: async () => { calls++; throw new Error('private original details'); } });
  await assert.rejects(sdk.grantBillingPlan('account-1', input), error => {
    assert.ok(error instanceof UsageIssuerError); assert.equal(error.requestKey, 'order-1'); assert.equal(error.outcome, 'unknown'); assert.equal(error.message.includes('private'), false); return true;
  });
  assert.equal(calls, 1);
});
test('wrong credential or path fails before IO and stable feedback survives error decoding', async () => {
  assert.throws(() => new UsageIssuerClient({ baseUrl: 'https://hub.example.com', issuerToken: 'business-token' }), TypeError);
  assert.throws(() => new UsageIssuerClient({ baseUrl: 'http://example.com', issuerToken }), TypeError);
  const sdk = new UsageIssuerClient({ baseUrl: 'https://hub.example.com', issuerToken, fetchImpl: async () => json({ code: 'USAGE_REVISION_CONFLICT', message: 'private body', feedback: { code: 'USAGE_REVISION_CONFLICT', next_action: 'refresh', token: 'secret' } }, 409) });
  assert.throws(() => sdk.getBillingSummary('../account'), TypeError);
  await assert.rejects(sdk.grantBillingPlan('account-1',input), error => {
    assert.equal(error.code, 'USAGE_REVISION_CONFLICT'); assert.equal(error.feedback.next_action, 'refresh'); assert.equal('token' in error.feedback, false); return true;
  });
});
test('summary still rejects missing, invalid, oversized and error responses', async () => {
  for (const [body, status] of [
    [null, 200], ['', 200], [' \n\t ', 200], ['nul', 200], ['{"incomplete":', 200],
    ['"null"', 200], ['false', 200], ['0', 200], [' '.repeat(1_048_576) + 'null', 200],
    ['null', 201], ['null', 401], ['null', 404], ['null', 500],
  ]) {
    let calls = 0;
    const sdk = new UsageIssuerClient({ baseUrl: 'https://hub.example.com', issuerToken, fetchImpl: async () => { calls++; return new Response(body, { status }); } });
    await assert.rejects(sdk.getBillingSummary('account-1'), error => {
      assert.equal(error.code, status === 404 ? 'USAGE_UNSUPPORTED' : 'USAGE_RESPONSE_INVALID');
      assert.equal(error.status, status); assert.equal(error.outcome, 'rejected'); return true;
    });
    assert.equal(calls, 1);
  }
  const sdk = new UsageIssuerClient({ baseUrl: 'https://hub.example.com', issuerToken, fetchImpl: async () => json({ code: 'USAGE_IDENTITY_REVOKED' }, 403) });
  await assert.rejects(sdk.getBillingSummary('account-1'), error => error.code === 'USAGE_IDENTITY_REVOKED' && error.outcome === 'rejected');
});
test('malformed or null mutation acknowledgements remain unknown and are never automatically retried', async () => {
  for (const body of ['null', '', 'nul', ' '.repeat(1_048_576) + 'null']) {
    let calls = 0;
    const sdk = new UsageIssuerClient({ baseUrl: 'https://hub.example.com', issuerToken, fetchImpl: async () => { calls++; return new Response(body); } });
    await assert.rejects(sdk.grantBillingPlan('account-1', input), error => {
      assert.equal(error.code, 'USAGE_RESPONSE_INVALID'); assert.equal(error.outcome, 'unknown'); assert.equal(error.requestKey, 'order-1'); return true;
    });
    assert.equal(calls, 1);
  }
});
