import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { createOperationalMetricsEndpointFor } from './operational-metrics';

const metrics = {
  enabled: true,
  token: 'metrics-only-token-with-enough-entropy-2026',
  scrapeTimeoutMs: 20,
};

function endpoint(input: {
  store: RuntimeStateStore;
  configStore?: ConfigStoreContract | null;
  logger?: Pick<Console, 'error'>;
}) {
  return createOperationalMetricsEndpointFor({
    cfg: { root: process.cwd(), metrics } as Pick<AppConfig, 'root' | 'metrics'>,
    store: input.store,
    configStore: input.configStore ?? null,
    queue: { stats: () => ({ running: 1, waiting: 2 }) },
    isPaused: () => false,
    auditFailures: { snapshot: () => ({ total: 3, lastFailureAt: null }) },
    logger: input.logger,
    build: { version: 'test', commit: 'abc123' },
  });
}

test('operational metrics: authorization accepts only the dedicated Bearer token', () => {
  const target = endpoint({ store: {} as RuntimeStateStore });
  assert.equal(target.authorize(undefined), false);
  assert.equal(target.authorize('metrics-only-token-with-enough-entropy-2026'), false);
  assert.equal(target.authorize('Bearer wrong-token-with-enough-entropy-2026'), false);
  assert.equal(target.authorize('Bearer metrics-only-token-with-enough-entropy-2026'), true);
});

test('operational metrics: optional collectors can be absent without breaking the endpoint', async () => {
  const text = await endpoint({ store: {} as RuntimeStateStore }).scrape();
  assert.match(text, /bailinghub_up 1/);
  assert.match(text, /bailinghub_metrics_collector_available\{collector="state"\} 0/);
  assert.match(text, /bailinghub_audit_write_failures_total 3/);
});

test('operational metrics: one collector failure is isolated and logged without the exception message', async () => {
  const logs: string[] = [];
  const store = {
    operationalMetricsSnapshot: async () => {
      throw new Error('password=should-not-be-logged');
    },
  } as unknown as RuntimeStateStore;
  const text = await endpoint({ store, logger: { error: (message) => logs.push(message) } }).scrape();

  assert.match(text, /bailinghub_metrics_collector_available\{collector="state"\} 1/);
  assert.match(text, /bailinghub_metrics_collector_success\{collector="state"\} 0/);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /"collector":"state"/);
  assert.doesNotMatch(logs[0]!, /should-not-be-logged|password/);
});

test('operational metrics: a stalled collector is bounded by the configured timeout', async () => {
  const logs: string[] = [];
  const store = {
    operationalMetricsSnapshot: async () => await new Promise<never>(() => undefined),
  } as unknown as RuntimeStateStore;
  const startedAt = Date.now();
  const text = await endpoint({ store, logger: { error: (message) => logs.push(message) } }).scrape();

  assert.ok(Date.now() - startedAt < 500);
  assert.match(text, /bailinghub_metrics_collector_success\{collector="state"\} 0/);
  assert.match(logs[0]!, /"failure":"timeout"/);
});
