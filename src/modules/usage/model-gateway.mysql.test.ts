import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUsageTestHarness } from './test-harness';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
const admin = 'synthetic-admin';
async function fixture(quota = 1_000_000, mode = 'credits') {
  const h = await createUsageTestHarness();
  const user = await h.seedUser({ grant: false });
  const planId = randomUUID();
  const config = { mode, serviceIds: [h.service.id], priceUsd: quota, multiplier: 1, ...(mode === 'periodic' ? { periodUnit: 'week', periodAllowanceUsd: quota } : {}),
    duration: { unit: 'month', count: 1 } };
  const plan = await h.request('/admin/api/usage/billing/plans', admin, 'POST', { id: planId, label: 'Synthetic USD plan', expected_revision: 0, config });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const grant = await h.request(`/admin/api/usage/billing/accounts/${user.accountId}/grant`, admin, 'POST', { request_key: planId, plan_id: planId, expected_revision: 0 });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  const input = (id = randomUUID()) => ({ operation_id: id, messages: [{ role: 'user', content: 'Synthetic product query' }] });
  return { ...h, user, planId, config, input };
}

test('Model HTTP: 300 steps without fee turns; no provider counting; one actual usage ledger', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const caps = await h.request('/usage/v1/capabilities', h.user.token);
    assert.equal(caps.body.model_gateway.turn_required, false);
    for (let i = 0; i < 300; i++) {
      const result = await h.request('/usage/v1/model/requests', h.user.token, 'POST', h.input());
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.result_state, 'complete'); assert.equal(result.body.billing_state, 'pending');
      await h.tokens.drainSettlements();
      const saved = await h.request(`/usage/v1/model/requests/${result.body.operation_id}`, h.user.token);
      assert.equal(saved.body.billed_usd, 25);
    }
    assert.equal(h.state.calls, 300); assert.equal(h.state.counts, 0);
    const [tables] = await h.pool.query<any[]>("SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE()");
    assert.equal(tables.length, 14); assert(!tables.some(row => /_(turns|entitlements|operations|ledger|plans)$/.test(row.TABLE_NAME ?? row.table_name) && !String(row.TABLE_NAME ?? row.table_name).includes('_billing_')));
    const summary = await h.request('/usage/v1/model/summary', h.user.token);
    assert.equal(summary.body.consumedUsd, 7500); assert.equal(summary.body.availableUsd, 992500);
    const legacy = await h.request('/usage/v1/turns', h.user.token, 'POST', { conversation_id: 'audit', service_id: h.service.id, request_key: randomUUID() });
    assert.equal(legacy.status, 404);
    assert.equal(caps.body.streaming, true); assert.equal(caps.body.orchestration, 'host');
    assert.equal(caps.body.presets, undefined); assert.equal(caps.body.token_gateway, undefined);
    for (const path of ['/usage/v1/summary','/usage/v1/ledger','/usage/v1/model','/usage/v1/model-operations','/usage/v1/external/plans','/admin/api/usage/plans']) {
      assert.equal((await h.request(path, path.startsWith('/admin') ? admin : h.user.token)).status, 404, path);
    }
  } finally { await h.close(); }
});

test('Model HTTP: soft final overage, duplicate ACK replay and depleted rejection', { skip: !enabled }, async () => {
  const h = await fixture(20);
  try {
    const input = h.input();
    const result = await h.request('/usage/v1/model/requests', h.user.token, 'POST', input);
    assert.equal(result.status, 200); assert.equal(result.body.result_state, 'complete');
    await h.tokens.drainSettlements();
    const saved = await h.request(`/usage/v1/model/requests/${input.operation_id}`, h.user.token);
    assert.equal(saved.body.overage_usd, 5);
    const repeat = await h.request('/usage/v1/model/requests', h.user.token, 'POST', input);
    assert.equal(repeat.body.operation_id, input.operation_id); assert.equal(h.state.calls, 1);
    const conflict = await h.request('/usage/v1/model/requests', h.user.token, 'POST', { ...input, messages: [{ role: 'user', content: 'different' }] });
    assert.equal(conflict.body.error, 'USAGE_IDEMPOTENCY_CONFLICT');
    const rejected = await h.request('/usage/v1/model/requests', h.user.token, 'POST', h.input());
    assert.equal(rejected.body.error, 'ALLOWANCE_INSUFFICIENT'); assert.equal(h.state.calls, 1);
    const summary = await h.request('/usage/v1/model/summary', h.user.token);
    assert.equal(summary.body.availableUsd, 0); assert.equal(summary.body.consumedUsd, 25);
  } finally { await h.close(); }
});

test('Model HTTP: complete result without usage is deliverable, later requests remain possible', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    h.state.mode = 'missing_usage'; const input = h.input();
    const result = await h.request('/usage/v1/model/requests', h.user.token, 'POST', input);
    assert.equal(result.status, 200); assert.equal(result.body.result_state, 'complete'); assert.equal(result.body.billing_state, 'pending');
    assert(JSON.parse(result.body.response.body)?.choices?.[0]);
    h.state.mode = 'ok'; const next = await h.request('/usage/v1/model/requests', h.user.token, 'POST', h.input());
    assert.equal(next.body.result_state, 'complete'); assert.equal(h.state.calls, 2);
    await h.tokens.drainSettlements();
    const recovered = await h.request(`/usage/v1/model/requests/${input.operation_id}`, h.user.token);
    assert.equal(recovered.body.result_state, 'complete'); assert.equal(h.state.calls, 2);
  } finally { await h.close(); }
});

test('Model HTTP: streaming previews, cancellation and late results cannot replay', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    h.state.mode = 'stream'; const input = h.input();
    const response = await fetch(`${h.baseUrl}/usage/v1/model/requests/stream`, { method: 'POST', headers: { authorization: `Bearer ${h.user.token}`, 'content-type':'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200); const reader = response.body!.getReader();
    const first = await reader.read(); assert(new TextDecoder().decode(first.value).includes('bailing.model-stream.v1'));
    while (!h.state.release) await new Promise(resolve => setTimeout(resolve, 5));
    const cancel = await h.request(`/usage/v1/model/requests/${input.operation_id}/cancel`, h.user.token, 'POST', {});
    assert.equal(cancel.status, 200); h.state.release();
    let rest = ''; for (;;) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); }
    await h.tokens.drainSettlements();
    const recovered = await h.request(`/usage/v1/model/requests/${input.operation_id}`, h.user.token);
    assert.equal(recovered.body.result_state, 'cancelled'); assert.equal(recovered.body.billing_state, 'settled');
    assert.equal(h.state.calls, 1); assert(!recovered.body.response);
  } finally { await h.close(); }
});

test('Model HTTP: original gateway credential follows plan models and labels with one shared allowance', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const second = await h.repository.putService({ id: 'second-model', label: 'Synthetic second', expectedRevision: 0, config: { ...h.service.config, model: 'synthetic-second' } });
    const exchange = await h.request('/usage/v1/sessions/exchange', h.issuerToken, 'POST', { request_key: randomUUID(), tenant: 'synthetic', subject: h.user.subject, service_id: h.service.id, model_access: 'token_gateway' });
    assert.equal(exchange.status, 200); const token = exchange.body.credential;
    const before = (await h.request('/usage/v1/model/summary', token)).body;
    const update = await h.request('/admin/api/usage/billing/plans', admin, 'POST', { id: h.planId, label: 'Synthetic USD plan', expected_revision: 1, config: { ...h.config, serviceIds: [h.service.id, second.id] } });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    const current = (await h.request(`/admin/api/usage/billing/accounts/${h.user.accountId}/summary`, admin)).body;
    assert.deepEqual(current.grant, before.grant);
    assert.equal(current.availableUsd, before.availableUsd);
    const denied = await h.request('/usage/v1/model/requests', h.user.token, 'POST', { ...h.input(), service_id: second.id });
    assert.equal(denied.status, 403); assert.equal(h.state.calls, 0);
    const models = await h.request('/usage/v1/model/models', token); assert.equal(models.body.items.length, 2);
    assert.equal(models.body.selection, 'plan'); assert.equal(models.body.plan_id, h.planId);
    assert.equal(models.body.items.find((m: any) => m.service_id === second.id).label, 'Synthetic second');
    for (const service_id of [h.service.id, second.id]) {
      const result = await h.request('/usage/v1/model/requests', token, 'POST', { ...h.input(), service_id });
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.service_id, service_id);
    }
    await h.tokens.drainSettlements();
    const summary = await h.request('/usage/v1/model/summary', token); assert.equal(summary.body.consumedUsd, 50);
    assert.equal(summary.body.grant.id, before.grant.id);
    assert.equal(Object.hasOwn(summary.body.grant.config, 'serviceIds'), false);
    const removed = await h.request('/admin/api/usage/billing/plans', admin, 'POST', { id: h.planId, label: 'Synthetic USD plan', expected_revision: 2, config: {...h.config, serviceIds:[second.id]} });
    assert.equal(removed.status, 200);
    const replaced = (await h.request('/usage/v1/model/models', token)).body;
    assert.equal(replaced.default_service_id, second.id); assert.equal(replaced.items.length, 1);
    const stale = await h.request('/usage/v1/model/requests', token, 'POST', {...h.input(), service_id:h.service.id});
    assert.equal(stale.status, 403); assert.equal(stale.body.feedback.next_action, 'select_model');
    assert.equal(h.state.calls, 2);
    const empty = await h.request('/admin/api/usage/billing/plans', admin, 'POST', { id: h.planId, label: 'Synthetic USD plan', expected_revision: 3, config: {...h.config, serviceIds:[]} });
    assert.equal(empty.status, 200);
    const emptyModels = (await h.request('/usage/v1/model/models', token)).body;
    assert.deepEqual(emptyModels.items, []); assert.equal(emptyModels.default_service_id, null);
    const externalSummary = await h.request(`/usage/v1/external/billing/accounts/${h.user.accountId}/summary`, h.issuerToken);
    assert.equal(externalSummary.status, 200); assert.equal(externalSummary.body.consumedUsd, 50);
    await h.identity.revokeExternalUser(await h.identity.authenticateIssuer(h.issuerToken, 'identity:revoke'), { tenant: 'synthetic', subject: h.user.subject });
    const revoked = await h.request('/usage/v1/model/requests', token, 'POST', h.input()); assert.equal(revoked.status, 401); assert.equal(h.state.calls, 2);
  } finally { await h.close(); }
});


test('Token external API: account ownership, source separation and admin write permission', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const other = await h.seedUser({ grant: false });
    const body = { request_key: randomUUID(), plan_id: h.planId, expected_revision: 0 };
    const opened = await h.request(`/usage/v1/external/billing/accounts/${other.accountId}/grant`, h.issuerToken, 'POST', body);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const repeated = await h.request(`/usage/v1/external/billing/accounts/${other.accountId}/grant`, h.issuerToken, 'POST', body);
    assert.equal(repeated.body.id, opened.body.id);
    const sourceConflict = await h.request(`/admin/api/usage/billing/accounts/${other.accountId}/grant`, admin, 'POST', { ...body, request_key: randomUUID(), expected_revision: 1 });
    assert.equal(sourceConflict.body.error, 'USAGE_SOURCE_CONFLICT');
    const outsider = await h.identity.createIssuer({ id: 'other-product', label: 'Other synthetic product', permissions: ['usage:read','entitlements:write','allowance:grant'], service_ids: [h.service.id] });
    const denied = await h.request(`/usage/v1/external/billing/accounts/${other.accountId}/summary`, outsider.credential!);
    assert.equal(denied.status, 403); assert.equal(denied.body.error, 'USAGE_ACCOUNT_FORBIDDEN');
    const readonly = await h.request('/admin/api/usage/billing/plans', 'synthetic-auditor', 'POST', { id: randomUUID(), label: 'Cannot write', expected_revision: 0, config: h.config });
    assert.equal(readonly.status, 403); assert.equal(h.state.calls, 0);
  } finally { await h.close(); }
});

test('native provider delivery never waits for settlement; recovery and retries bill once without dispatch', { skip: !enabled }, async () => {
  const h = await fixture();
  // Hold only the financial step, after durable provider evidence; no shared database is used.
  const internal = h.tokens as any, settle = internal.settleRecorded.bind(h.tokens);
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  internal.settleRecorded = async (record: unknown) => { entered = true; await gate; return settle(record); };
  try {
    const input = h.input();
    const response = await h.request('/usage/v1/model/requests', h.user.token, 'POST', input);
    assert.equal(response.body.result_state, 'complete'); assert.equal(response.body.billing_state, 'pending');
    assert.equal(response.body.next_action, 'none');
    assert.equal(response.body.response.schema, 'bailing.provider-response.v1');
    while (!entered) await new Promise(resolve => setTimeout(resolve, 2));
    const recovered = await h.request(`/usage/v1/model/requests/${input.operation_id}`, h.user.token);
    assert.deepEqual(recovered.body.response, response.body.response); assert.equal(recovered.body.billing_state, 'pending');
    const duplicate = await h.request('/usage/v1/model/requests', h.user.token, 'POST', input);
    assert.deepEqual(duplicate.body.response, response.body.response); assert.equal(h.state.calls, 1);
    release(); await h.tokens.drainSettlements();
    await h.tokens.reconcilePendingUsage(); await h.tokens.reconcilePendingUsage();
    const summary = await h.request('/usage/v1/model/summary', h.user.token);
    assert.equal(summary.body.consumedUsd, 25); assert.equal(h.state.calls, 1);
  } finally { release(); internal.settleRecorded = settle; await h.close(); }
});

test('provider error, nullable tools and semantic truncation reach local adapter as original bodies', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    for (const mode of ['error', 'incomplete', 'stream_tools_nullable'] as const) {
      h.state.mode = mode;
      const response = await fetch(`${h.baseUrl}/usage/v1/model/requests/stream`, { method: 'POST',
        headers: { authorization: `Bearer ${h.user.token}`, 'content-type': 'application/json' }, body: JSON.stringify(h.input()) });
      const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      const original = events.filter(event => event.type === 'provider').map(event => event.provider.data).join('');
      const result = events.find(event => event.type === 'operation')!.operation;
      assert.equal(result.result_state, 'complete'); assert.equal(result.response.body, original);
      assert.equal(result.response.status, mode === 'error' ? 503 : 200);
      assert.notEqual(result.resolution, 'USAGE_PROVIDER_RESPONSE_INVALID');
    }
    assert.equal(h.state.calls, 3);
  } finally { await h.close(); }
});
