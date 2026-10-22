import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUsageTestHarness } from './test-harness';
import type { UsageServiceConfig } from './contracts';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
const input = (provider_options?: Record<string, unknown>) => ({ operation_id: randomUUID(), messages: [{ role: 'user', content: 'Synthetic budget acceptance' }],
  ...(provider_options ? { provider_options } : {}) });

test('Model budget HTTP: persisted policy, live directory, explicit defaults, exact cap and safe pre-dispatch rejection', { skip: !enabled }, async () => {
  const h = await createUsageTestHarness();
  try {
    const user = await h.seedUser();
    const policy: UsageServiceConfig = { ...h.service.config, maxOutputTokens: 131072, defaultOutputTokens: 32768,
      outputTokenParameter: 'max_completion_tokens', outputBudgetScope: 'completion_total', modelMaxOutputTokens: 131072 };
    const saved = await h.repository.putService({ id: h.service.id, label: h.service.label, expectedRevision: 1, config: policy });
    assert.equal(saved.revision, 2);
    assert.deepEqual((await h.repository.getService(h.service.id))?.config, policy);
    const directory = await h.request('/usage/v1/model/models', user.token);
    const descriptor = directory.body.items[0];
    assert.equal(descriptor.default_output_tokens, 32768);
    assert.equal(descriptor.max_output_tokens, 131072);
    assert.equal(descriptor.model_max_output_tokens, 131072);
    assert.equal(descriptor.output_token_parameter, 'max_completion_tokens');
    assert.equal(descriptor.output_budget_scope, 'completion_total');
    assert(!descriptor.provider_options.includes('max_tokens'));
    for (const tokens of [undefined, 8192, 16384, 65536, 131072]) {
      const result = await h.request('/usage/v1/model/requests', user.token, 'POST', input(tokens === undefined ? undefined : { max_completion_tokens: tokens }));
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(h.state.bodies.at(-1)?.max_completion_tokens, tokens ?? 32768);
      assert.equal(h.state.bodies.at(-1)?.max_tokens, undefined);
    }
    const calls = h.state.calls;
    const above = await h.request('/usage/v1/model/requests', user.token, 'POST', input({ max_completion_tokens: 131073 }));
    assert.equal(above.status, 413);
    assert.deepEqual(above.body.feedback.output_limit, { actual: 131073, allowed: 131072, parameter: 'max_completion_tokens', scope: 'completion_total' });
    assert.equal(above.body.feedback.dispatch, 'not_dispatched');
    const wrong = await h.request('/usage/v1/model/requests', user.token, 'POST', input({ max_tokens: 32768 }));
    assert.equal(wrong.status, 400);
    assert.deepEqual(wrong.body.feedback.output_budget, { expected_parameter: 'max_completion_tokens', scope: 'completion_total' });
    assert.equal(wrong.body.feedback.dispatch, 'not_dispatched');
    const both = await h.request('/usage/v1/model/requests', user.token, 'POST', input({ max_tokens: 1, max_completion_tokens: 1 }));
    assert.equal(both.status, 400);
    assert.equal(h.state.calls, calls);
    assert.equal(JSON.stringify([wrong.body, above.body]).includes('Synthetic budget acceptance'), false);
  } finally { await h.close(); }
});

test('Model budget HTTP: already admitted original stays recoverable after policy changes; unadmitted old intent is not rewritten', { skip: !enabled }, async () => {
  const h = await createUsageTestHarness();
  try {
    const user = await h.seedUser();
    const original = input({ max_tokens: 80 });
    const before = JSON.stringify(original);
    const first = await h.request('/usage/v1/model/requests', user.token, 'POST', original);
    assert.equal(first.status, 200);
    assert.equal(h.state.bodies[0]?.max_tokens, 80);
    await h.tokens.drainSettlements();
    const policy: UsageServiceConfig = { ...h.service.config, maxOutputTokens: 65536, defaultOutputTokens: 32768,
      outputTokenParameter: 'max_completion_tokens', outputBudgetScope: 'completion_total' };
    await h.repository.putService({ id: h.service.id, label: h.service.label, expectedRevision: 1, config: policy });
    const recovery = await h.request(`/usage/v1/model/requests/${original.operation_id}`, user.token);
    assert.equal(recovery.status, 200);
    assert.deepEqual(recovery.body.response, first.body.response);
    const repeat = await h.request('/usage/v1/model/requests', user.token, 'POST', original);
    assert.equal(repeat.status, 200);
    assert.deepEqual(repeat.body.response, first.body.response);
    assert.equal(h.state.calls, 1, 'policy refresh must never dispatch an admitted operation twice');
    const unadmitted = { ...original, operation_id: randomUUID() };
    const rejected = await h.request('/usage/v1/model/requests', user.token, 'POST', unadmitted);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, 'USAGE_OUTPUT_PARAMETER_MISMATCH');
    assert.equal(rejected.body.dispatch, 'not_dispatched');
    assert.equal(h.state.calls, 1);
    assert.equal(JSON.stringify(original), before);
    const next = await h.request('/usage/v1/model/requests', user.token, 'POST', input({ max_completion_tokens: 32768 }));
    assert.equal(next.status, 200);
    assert.equal(h.state.bodies[1]?.max_completion_tokens, 32768);
    await h.tokens.drainSettlements();
    const summary = await h.request('/usage/v1/model/summary', user.token);
    assert.equal(summary.body.consumedUsd, 50, 'only two genuine provider dispatches are billed');
  } finally { await h.close(); }
});
