import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolProvider } from '../../core/contracts/types';
import { ToolProviderRepository } from './config-tool-provider-repository';

function provider(): ToolProvider {
  return {
    name: 'orders',
    base_url: 'https://biz.example.com',
    spec_source: 'url',
    spec_access_policy: 'signed_required',
    spec_url: 'https://biz.example.com/.well-known/bailing/tools.json',
    spec_access_probe: {
      status: 'protected',
      signed_http: 200,
      unsigned_http: 401,
      invalid_http: 403,
      at: '2026-08-05T12:00:00.000Z',
    },
    secret: 'secret',
    log_payload: true,
    timeout_ms: 10000,
    rate_limit_per_min: 120,
    auto_refresh_min: 0,
    enabled: true,
  };
}

test('ToolProviderRepository.upsert persists spec access policy and probe', async () => {
  const calls: unknown[][] = [];
  const repository = new ToolProviderRepository(() => ({
    async query(...args: unknown[]) { calls.push(args); return [[], []]; },
  }));

  await repository.upsert(provider());

  assert.equal(calls.length, 1);
  const [sql, values] = calls[0] as [string, unknown[]];
  assert.match(sql, /spec_access_policy/);
  assert.match(sql, /spec_access_probe_json/);
  assert.equal(values[3], 'signed_required');
  assert.deepEqual(JSON.parse(String(values[7])), provider().spec_access_probe);
});

test('ToolProviderRepository.upsert normalizes the legacy read sentinel to SQL NULL', async () => {
  const calls: unknown[][] = [];
  const repository = new ToolProviderRepository(() => ({
    async query(...args: unknown[]) { calls.push(args); return [[], []]; },
  }));

  await repository.upsert({ ...provider(), spec_access_policy: 'legacy_unverified' });

  const [, values] = calls[0] as [string, unknown[]];
  assert.equal(values[3], null);
});

test('ToolProviderRepository.updateSpecAccessProbe updates only the probe result and timestamp', async () => {
  const calls: unknown[][] = [];
  const repository = new ToolProviderRepository(() => ({
    async query(...args: unknown[]) { calls.push(args); return [[], []]; },
  }));
  const probe = provider().spec_access_probe!;

  await repository.updateSpecAccessProbe('orders', probe);

  assert.equal(calls.length, 1);
  const [sql, values] = calls[0] as [string, unknown[]];
  assert.equal(sql, 'UPDATE bz_tool_providers SET spec_access_probe_json=?, updated_at=? WHERE name=?');
  assert.deepEqual(JSON.parse(String(values[0])), probe);
  assert.equal(values[2], 'orders');
});
