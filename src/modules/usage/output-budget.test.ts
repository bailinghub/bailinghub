import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { UsageService, UsageServiceConfig } from './contracts';
import { outputBudgetDescriptor, outputBudgetPolicy } from './output-budget';
import { providerBody, normalizeModelRequest, executeProvider } from './provider';
import { modelDescriptor } from './model-gateway';
import { UsageRepository } from './repository';
import { usageHttpError } from './http';
import { UsageError } from './errors';

const legacy: UsageServiceConfig = { credential: 'private-credential', model: 'synthetic-only', providerScope: 'private-route',
  maxInputBytes: 16384, maxOutputTokens: 65536, timeoutMs: 1000 };
const explicit: UsageServiceConfig = { ...legacy, defaultOutputTokens: 32768, outputTokenParameter: 'max_completion_tokens',
  outputBudgetScope: 'completion_total', modelMaxOutputTokens: 131072 };
const input = (provider_options?: Record<string, unknown>) => normalizeModelRequest({ operation_id: 'synthetic-budget',
  messages: [{ role: 'user', content: 'Synthetic request; never a paid model call.' }], ...(provider_options ? { provider_options } : {}) });
const service = (config: UsageServiceConfig): UsageService => ({ id: 'synthetic', label: 'Synthetic', revision: 2, state: 'active', config });

function errorJson(error: unknown) {
  let raw = '';
  const res = { writeHead() {}, end(value: string) { raw = value; } } as unknown as ServerResponse;
  usageHttpError(res, error);
  return JSON.parse(raw);
}

test('legacy policy does not invent an independent default, vendor maximum or reasoning scope', () => {
  assert.equal(outputBudgetPolicy(legacy), null);
  assert.deepEqual(outputBudgetDescriptor(legacy), {});
  const descriptor = modelDescriptor(service(legacy));
  assert.equal(descriptor.max_output_tokens, 65536);
  for (const field of ['default_output_tokens', 'output_token_parameter', 'output_budget_scope', 'model_max_output_tokens'])
    assert.equal(Object.hasOwn(descriptor, field), false);
  assert(descriptor.provider_options.includes('max_tokens'));
  assert(descriptor.provider_options.includes('max_completion_tokens'));
  assert.equal(providerBody(input(), legacy).max_tokens, 65536);
  assert.equal(providerBody(input({ max_completion_tokens: 1234 }), legacy).max_completion_tokens, 1234);
  assert.equal(providerBody(input({ max_tokens: 1234 }), legacy).max_tokens, 1234);
});

test('explicit default is distinct from the service ceiling and advertised parameter matches actual dispatch', () => {
  assert.deepEqual(outputBudgetPolicy(explicit), { defaultTokens: 32768, maxTokens: 65536, parameter: 'max_completion_tokens',
    scope: 'completion_total', modelMaxTokens: 131072 });
  const descriptor = modelDescriptor(service(explicit));
  assert.equal(descriptor.default_output_tokens, 32768);
  assert.equal(descriptor.max_output_tokens, 65536);
  assert.equal(descriptor.model_max_output_tokens, 131072);
  assert.equal(descriptor.output_token_parameter, 'max_completion_tokens');
  assert.equal(descriptor.output_budget_scope, 'completion_total');
  assert(!descriptor.provider_options.includes('max_tokens'));
  assert(descriptor.provider_options.includes('max_completion_tokens'));
  assert.equal(JSON.stringify(descriptor).includes('private-'), false);
  const original = input();
  const before = JSON.stringify(original);
  const body = providerBody(original, explicit);
  assert.equal(body.max_completion_tokens, 32768);
  assert.equal(Object.hasOwn(body, 'max_tokens'), false);
  assert.equal(JSON.stringify(original), before, 'wire default must not mutate prepared intent');
  assert.equal(providerBody(input({ max_completion_tokens: 65536 }), explicit).max_completion_tokens, 65536);
  for (const scope of ['final_answer', 'completion_total'] as const) {
    const config = { ...explicit, outputTokenParameter: 'max_tokens' as const, outputBudgetScope: scope };
    assert.equal(providerBody(input(), config).max_tokens, 32768);
    assert.equal(modelDescriptor(service(config)).output_budget_scope, scope);
  }
});

test('partial, ambiguous and impossible policies fail before repository persistence', async () => {
  let transactions = 0;
  const repository = new UsageRepository(() => { throw new Error('must not touch a database for invalid config'); });
  repository.withTransaction = async () => { transactions++; throw new Error('invalid config reached persistence'); };
  const invalid = [
    { ...legacy, defaultOutputTokens: 32768 }, { ...legacy, outputTokenParameter: 'max_tokens' },
    { ...legacy, outputBudgetScope: 'final_answer' }, { ...legacy, modelMaxOutputTokens: 131072 },
    { ...explicit, outputTokenParameter: 'unknown' }, { ...explicit, outputBudgetScope: 'unknown' },
    { ...explicit, outputBudgetScope: 'final_answer' },
    { ...explicit, defaultOutputTokens: 65537 }, { ...explicit, defaultOutputTokens: 0 },
    { ...explicit, defaultOutputTokens: '32768' }, { ...explicit, defaultOutputTokens: null },
    { ...explicit, defaultOutputTokens: 1.5 }, { ...explicit, defaultOutputTokens: Infinity },
    { ...explicit, maxOutputTokens: 131073 }, { ...explicit, modelMaxOutputTokens: 65535 },
    { ...explicit, modelMaxOutputTokens: 0 }, { ...explicit, modelMaxOutputTokens: '131072' },
    { ...explicit, modelMaxOutputTokens: 10000001 },
  ];
  for (const config of invalid) {
    assert.throws(() => outputBudgetPolicy(config as UsageServiceConfig), { code: 'USAGE_INVALID_INPUT', status: 400 });
    await assert.rejects(repository.putService({ id: 'synthetic', label: 'Synthetic', expectedRevision: 0,
      config: config as UsageServiceConfig }), { code: 'USAGE_INVALID_INPUT', status: 400 });
  }
  assert.equal(transactions, 0);
  assert.equal(outputBudgetPolicy({ ...explicit, defaultOutputTokens: 1 })?.defaultTokens, 1);
  assert.equal(outputBudgetPolicy({ ...explicit, modelMaxOutputTokens: 10000000 })?.modelMaxTokens, 10000000);
  assert.equal(outputBudgetPolicy({ ...legacy, purpose: 'tool' }), null, 'old image residue remains inert');
  assert.throws(() => outputBudgetPolicy({ ...explicit, purpose: 'tool' }), { code: 'USAGE_INVALID_INPUT' });
});

test('wrong parameter is rejected without renaming and over-limit feedback contains only safe scalars', () => {
  const original = input({ max_tokens: 32768 });
  const before = JSON.stringify(original);
  assert.throws(() => providerBody(original, explicit), (error: unknown) => {
    assert(error instanceof UsageError);
    assert.equal(error.code, 'USAGE_OUTPUT_PARAMETER_MISMATCH');
    assert.equal(error.status, 400);
    const result = errorJson(error);
    assert.deepEqual(result.feedback.output_budget, { expected_parameter: 'max_completion_tokens', scope: 'completion_total' });
    assert.equal(result.feedback.dispatch, 'not_dispatched');
    assert.equal(result.feedback.retryable, false);
    assert.equal(result.feedback.next_action, 'resolve_error');
    assert.equal(JSON.stringify(result).includes('Synthetic request'), false);
    return true;
  });
  assert.equal(JSON.stringify(original), before);
  for (const config of [legacy, explicit]) {
    const parameter = config.outputTokenParameter ?? 'max_tokens';
    assert.throws(() => providerBody(input({ [parameter]: 65537 }), config), (error: unknown) => {
      assert(error instanceof UsageError);
      assert.equal(error.code, 'USAGE_OUTPUT_LIMIT');
      assert.equal(error.status, 413);
      const result = errorJson(error);
      assert.equal(result.feedback.dispatch, 'not_dispatched');
      assert.deepEqual(result.feedback.output_limit, { actual: 65537, allowed: 65536, parameter,
        ...(config.outputBudgetScope ? { scope: config.outputBudgetScope } : {}) });
      assert.equal(JSON.stringify(result).includes('private-'), false);
      return true;
    });
  }
  for (const options of [ { max_tokens: 1, max_completion_tokens: 1 }, { max_completion_tokens: 0 },
    { max_completion_tokens: -1 }, { max_completion_tokens: 1.5 }, { max_completion_tokens: '32768' } ]) {
    assert.throws(() => input(options), { code: 'USAGE_INVALID_INPUT' });
  }
});

test('synthetic HTTP provider receives configured parameter and budget with reasoning settings preserved', async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'synthetic' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 5 } } }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const credential = { base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api_key: 'synthetic-test-only' };
    const configs: UsageServiceConfig[] = [legacy, explicit, { ...explicit, outputTokenParameter: 'max_tokens', outputBudgetScope: 'final_answer' }];
    for (const config of configs) {
      const options = { reasoning_effort: 'high', thinking: { budget_tokens: 8192 } };
      const result = await executeProvider(credential, config, providerBody(input(options), config));
      assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 8 }, 'reasoning subset is not charged a second time');
    }
    assert.equal(bodies.length, 3, 'no automatic retry or token probe');
    assert.equal(bodies[0]?.max_tokens, 65536);
    assert.equal(bodies[1]?.max_completion_tokens, 32768);
    assert.equal(bodies[1]?.max_tokens, undefined);
    assert.equal(bodies[2]?.max_tokens, 32768);
    assert.equal(bodies[2]?.max_completion_tokens, undefined);
    for (const body of bodies) {
      assert.equal(body.reasoning_effort, 'high');
      assert.deepEqual(body.thinking, { budget_tokens: 8192 });
      assert.equal(body.credential, undefined);
      assert.equal(body.providerScope, undefined);
    }
  } finally {
    server.close(); server.closeAllConnections(); await once(server, 'close');
  }
});
