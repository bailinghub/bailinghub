import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runModelRequest, type ModelInput } from './model-gateway';
import { getBillingRepository } from './billing-repository';
import { referencePricing } from './pricing';
import type { UsageRepository } from './repository';
import type { UsageSessionContext } from './identity';
import type { UsageService } from './contracts';
import type { BillingRequest } from './billing-contracts';

/** Gateway ordering acceptance with synthetic persistence/pricing ports. Not a DB/transaction proof. */
function fixture() {
  const actor: UsageSessionContext = { accountId: 'account', userId: 'user', sessionId: 'session', serviceId: 'model',
    issuerId: 'synthetic', expiresAt: Date.now() + 60000 };
  const service: UsageService = { id: 'model', label: 'Synthetic', state: 'active', revision: 1,
    config: { credential: 'synthetic', model: 'synthetic', providerScope: 'synthetic', maxInputBytes: 65536,
      maxOutputTokens: 64, timeoutMs: 5000 } };
  const repository = { backgroundWork: { acceptingRequests: true }, getService: async () => service } as unknown as UsageRepository;
  const ledger = getBillingRepository(repository), records = new Map<string, BillingRequest>();
  const price = { source: 'openrouter' as const, modelId: 'synthetic/model', endpointId: 'synthetic', currency: 'USD' as const,
    fetchedAt: Date.now(), lines: [{ billable: 'prompt', unit: 'token' as const, costUsd: '1' }, { billable: 'completion', unit: 'token' as const, costUsd: '1' }] };
  const allowance = { mode: 'credits' as const, priceUsd: 1000, duration: { unit: 'month' as const, count: 1 } };
  ledger.summary = async () => ({ schema: 'bailing.billing-summary.v1', accountId: actor.accountId,
    grant: { id: 'grant', accountId: actor.accountId, planId: 'plan', planRevision: 1, label: 'Synthetic', revision: 1,
      state: 'active', sourceOwner: 'synthetic', startsAt: Date.now(), expiresAt: null, config: allowance },
    plan: { id: 'plan', label: 'Synthetic', revision: 1, serviceIds: ['model'], multiplier: 1 },
    availableUsd: 1000, consumedUsd: 0, currentPeriodConsumedUsd: 0, overageUsd: 0, resetAt: null,
    expiresAt: null, pendingRequests: 0, presentation: { schema: 'bailing.usage-presentation.v1', kind: 'credits',
      state: 'active', remaining: 1000, total: 1000, displayValue: '1000' } });
  ledger.findRequest = async (_actor, operationId) => records.get(operationId) ?? null;
  ledger.admit = async input => {
    const record: BillingRequest = { id: input.operationId, operationId: input.operationId, accountId: actor.accountId, userId: actor.userId,
      sessionId: actor.sessionId, model: input.model, grantId: 'grant', grantRevision: 1, grantConfig: allowance,
      periodStart: Date.now(), periodEnd: null, cancelledAt: null, updatedAt: Date.now(),
      serviceId: input.serviceId, conversationId: input.conversationId, turnId: input.turnId, requestHash: input.requestHash,
      serviceConfig: structuredClone(input.serviceConfig), serviceRevision: input.expectedServiceRevision,
      billingRate: { planId: 'plan', planRevision: 1, multiplier: 1, price }, revision: 1,
      state: 'admitted', resultState: 'pending', billingState: 'pending', fence: null, response: null, resultHash: null,
      usage: null, rawUsage: null, referenceCostUsd: null, billedUsd: null, overageUsd: null, createdAt: Date.now() };
    records.set(input.operationId, record); return { ...record, created: true };
  };
  ledger.commitDispatch = async id => { const record = records.get(id)!; record.state = 'dispatch_committed'; record.fence = 'synthetic-fence'; return record; };
  ledger.recordCompletion = async (id, _fence, input) => {
    const record = records.get(id)!;
    Object.assign(record, { state: 'completed', resultState: 'complete', response: input.response,
      resultHash: createHash('sha256').update(JSON.stringify(input.response)).digest('hex'), rawUsage: input.rawUsage ?? null,
      usage: input.usage ? { ...input.usage, totalTokens: input.usage.inputTokens + input.usage.outputTokens } : null });
    return record;
  };
  ledger.markUnknown = async (id, _fence, _reason) => {
    const record = records.get(id)!; record.state = 'unknown'; record.resultState = 'unknown'; return record;
  };
  referencePricing(repository).snapshot = async () => price;
  const bodies: Record<string, unknown>[] = [];
  let mode: 'length' | 'stop' | 'lost' = 'length';
  const fetcher: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (mode === 'lost') throw new Error('Synthetic transport loss after dispatch');
    return new Response(JSON.stringify({ id: `supplier-${bodies.length}`, choices: [{ index: 0,
      message: { role: 'assistant', content: mode === 'length' ? '第一步已完成；第二步' : '第二步已完成。' }, finish_reason: mode }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }), { headers: { 'content-type': 'application/json' } });
  };
  const deps = { usage: repository, cfg: { llmCredentials: { synthetic: { base_url: 'http://127.0.0.1:1/v1', api_key: 'SYNTHETIC_ONLY' } } }, fetcher };
  const input = (operation_id: string): ModelInput => ({ operation_id, conversation_id: 'conversation', turn_id: 'task',
    messages: [{ role: 'user', content: 'Synthetic multi-step task' }] });
  return { actor, ledger, records, bodies, deps, input, setMode(value: typeof mode) { mode = value; } };
}

test('length is a completed provider exchange; original recovery never dispatches and a host continuation is a distinct request', async () => {
  const h = fixture(), original = h.input('original');
  original.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'completed-call', type: 'function',
    function: { name: 'inspect_step_1', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'completed-call', content: 'Step 1 already completed; immutable original result.' });
  const before = JSON.stringify(original);
  const first = await runModelRequest(h.deps, h.actor, original);
  assert.equal(first.result_state, 'complete'); assert.equal(first.dispatch, 'completed'); assert.equal(first.billing_state, 'pending');
  const response = first.response!;
  const partial = JSON.parse(String(response.body));
  assert.equal(partial.choices[0].finish_reason, 'length'); assert.equal(h.bodies.length, 1);
  const recovery = h.ledger.view((await h.ledger.findRequest(h.actor, original.operation_id))!);
  assert.deepEqual(recovery.response, response);
  const repeated = await runModelRequest(h.deps, h.actor, original);
  assert.deepEqual(repeated.response, response); assert.equal(h.bodies.length, 1);
  await assert.rejects(runModelRequest(h.deps, h.actor, { ...original, messages: [...original.messages, { role: 'user', content: 'different' }] }),
    { code: 'USAGE_IDEMPOTENCY_CONFLICT' });
  assert.equal(h.bodies.length, 1);
  h.setMode('stop');
  const next = { ...h.input('continuation-1'), messages: [...original.messages,
    { role: 'assistant', content: partial.choices[0].message.content },
    { role: 'system', content: 'Runtime continuation context: continue from the saved result; do not repeat completed step 1.' }] };
  const completed = await runModelRequest(h.deps, h.actor, next);
  assert.equal(completed.result_state, 'complete'); assert.equal(completed.operation_id, 'continuation-1');
  assert.equal(h.bodies.length, 2); assert.deepEqual(h.bodies[1]!.messages, next.messages);
  assert.deepEqual((h.bodies[1]!.messages as Record<string, unknown>[]).filter(message => message.role === 'tool'),
    original.messages.filter(message => message.role === 'tool'), 'the next model request receives the saved tool result, not a request to rerun it');
  assert.equal(JSON.stringify(original), before, 'continuation must not mutate the original intent');
  assert.deepEqual((await runModelRequest(h.deps, h.actor, original)).response, response); assert.equal(h.bodies.length, 2);
});

test('transport uncertainty remains original-ID recovery and is not an automatic new model call', async () => {
  const h = fixture(); h.setMode('lost'); const original = h.input('original-lost');
  const result = await runModelRequest(h.deps, h.actor, original);
  assert.equal(result.result_state, 'unknown'); assert.equal(result.dispatch, 'unknown'); assert.equal(result.next_action, 'inspect_original');
  assert.equal(h.bodies.length, 1);
  h.setMode('stop');
  const repeated = await runModelRequest(h.deps, h.actor, original);
  assert.equal(repeated.result_state, 'unknown'); assert.equal(h.bodies.length, 1);
});
