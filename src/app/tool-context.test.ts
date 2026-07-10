import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAllowedToolsFor } from './tool-context';
import type { Job, Route, ToolProvider } from '../core/contracts/types';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

function provider(name: string, operationId: string, scope: string): ToolProvider {
  return {
    name,
    base_url: `https://${name}.example.com`,
    secret: 'secret',
    enabled: true,
    spec_source: 'inline',
    spec_json: JSON.stringify({
      openapi: '3.0.0', info: { title: name, version: '1' },
      paths: { [`/${operationId}`]: { get: { operationId, summary: operationId, 'x-agent-capability': { version: 1, enabled: true, scope } } } },
    }),
    log_payload: false,
    timeout_ms: 10_000,
    rate_limit_per_min: 60,
  } as ToolProvider;
}

function configWith(providers: ToolProvider[]): ConfigStoreContract {
  const byName = new Map(providers.map((item) => [item.name, item]));
  return { toolProviders: { get: async (name: string) => byName.get(name) ?? null } } as unknown as ConfigStoreContract;
}

const job: Job = {
  job_id: 'job-1',
  request_id: 'req-1',
  status: 'running',
  profile: 'general',
  project: '',
  source: 'test',
  input_preview: 'test',
  metadata: { operator_uid: 'user-9' },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function routeWithTools(tools: Record<string, unknown>): Route {
  return {
    route_key: 'test-route',
    name: 'Test route',
    enabled: true,
    target: 'llm',
    target_config: {},
    profile: 'general',
    session_policy: 'new',
    tools,
  };
}

test('resolveAllowedToolsFor: 一条路由聚合多个工具源并保留各自 provider/主体', async () => {
  const route = routeWithTools({
    sources: [
      { provider: 'orders', allow: ['order.*'], subject_field: 'operator_uid' },
      { provider: 'shipping', allow: ['shipment.*'], subject_field: 'operator_uid' },
    ],
    max_calls: 8,
  });
  const result = await resolveAllowedToolsFor(configWith([
    provider('orders', 'order_list', 'order.read'),
    provider('shipping', 'shipment_track', 'shipment.read'),
  ]), job, route);

  assert.deepEqual(result?.sources.map((source) => source.provider.name), ['orders', 'shipping']);
  assert.deepEqual(result?.allowed.map((tool) => tool.name), ['order_list', 'shipment_track']);
  assert.deepEqual(result?.sources.map((source) => source.onBehalfOf), ['user-9', 'user-9']);
});

test('resolveAllowedToolsFor: 跨工具源同名 operationId 在装配前拒绝', async () => {
  const route = routeWithTools({ sources: [{ provider: 'orders', allow: ['*'] }, { provider: 'shipping', allow: ['*'] }] });
  await assert.rejects(
    resolveAllowedToolsFor(configWith([
      provider('orders', 'lookup', 'order.read'),
      provider('shipping', 'lookup', 'shipment.read'),
    ]), job, route),
    /工具名冲突 lookup/,
  );
});
