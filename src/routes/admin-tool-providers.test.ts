import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../core/config/config';
import type { ToolProvider } from '../core/contracts/types';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { handleAdminToolProviderApiFor } from './admin-tool-providers';

class FakeResponse {
  statusCode = 0;
  body: Uint8Array = Buffer.alloc(0);

  writeHead(code: number): void {
    this.statusCode = code;
  }

  end(chunk?: string | Buffer): void {
    if (chunk) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }

  json(): Record<string, unknown> {
    return JSON.parse(Buffer.from(this.body).toString('utf8')) as Record<string, unknown>;
  }
}

function request(body: Record<string, unknown>): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  stream.headers = {};
  return stream;
}

function historicalProvider(): ToolProvider {
  return {
    name: 'old-url-tools',
    base_url: 'https://biz.example.com',
    spec_source: 'url',
    spec_access_policy: 'legacy_unverified',
    spec_url: 'https://biz.example.com/tools.json',
    secret: 'secret',
    log_payload: true,
    timeout_ms: 10000,
    rate_limit_per_min: 120,
    auto_refresh_min: 0,
    enabled: true,
    description: 'old description',
  };
}

function deps(old: ToolProvider, upserts: ToolProvider[]) {
  const toolProviders = {
    get: async (name: string) => name === old.name ? old : null,
    upsert: async (provider: ToolProvider) => { upserts.push(provider); },
    updateAuthzProbe: async () => undefined,
  };
  return {
    cfg: { server: {}, brand: { name: 'Test' } } as unknown as AppConfig,
    configStore: { toolProviders } as unknown as ConfigStoreContract,
    stateStore: { appendAudit: async () => undefined } as unknown as RuntimeStateStore,
    toolIndex: null,
    now: () => '2026-08-06T00:00:00.000Z',
    sleep: async () => undefined,
  };
}

test('admin policy edits persist without changing the business declaration or legacy access intent', async () => {
  const old = historicalProvider();
  const upserts: ToolProvider[] = [];
  const policy = { default: { mode: 'disabled' }, overrides: { images_update: { mode: 'custom', count: 1000, window: '1h' } } };
  const payload = { name: old.name, base_url: old.base_url, spec_source: old.spec_source, spec_url: old.spec_url, rate_limit_per_min: 0, tool_rate_limits: policy };
  const res = new FakeResponse();
  await handleAdminToolProviderApiFor(deps(old, upserts), 'POST', '/admin/api/tool-providers', request(payload), res as unknown as ServerResponse, { kind: 'admin', via: 'token' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(upserts[0]!.tool_rate_limits, policy);
  assert.equal(upserts[0]!.rate_limit_per_min, 0);
  assert.equal(upserts[0]!.spec_access_policy, 'legacy_unverified');
  assert.equal(upserts[0]!.secret, old.secret);
  const after = new FakeResponse();
  const { tool_rate_limits: _omitted, ...unchanged } = payload;
  await handleAdminToolProviderApiFor(deps(upserts[0]!, upserts), 'POST', '/admin/api/tool-providers', request(unchanged), after as unknown as ServerResponse, { kind: 'admin', via: 'token' });
  assert.deepEqual(upserts[1]!.tool_rate_limits, policy);
  const invalid = new FakeResponse();
  await handleAdminToolProviderApiFor(deps(upserts[1]!, upserts), 'POST', '/admin/api/tool-providers', request({ ...payload, tool_rate_limits: { default: { mode: 'custom', count: 0, window: '1h' } } }), invalid as unknown as ServerResponse, { kind: 'admin', via: 'token' });
  assert.equal(invalid.statusCode, 400);
  assert.equal(upserts.length, 2);
});

test('admin tool-provider route: 直接 API 不能绕过历史 URL 源的策略确认', async () => {
  const upserts: ToolProvider[] = [];
  const old = historicalProvider();
  const res = new FakeResponse();
  const handled = await handleAdminToolProviderApiFor(
    deps(old, upserts),
    'POST',
    '/admin/api/tool-providers',
    request({
      name: old.name,
      base_url: old.base_url,
      spec_source: 'url',
      spec_url: 'https://biz.example.com/tools-v2.json',
    }),
    res as unknown as ServerResponse,
    { kind: 'admin', via: 'token' },
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.json()['error']), /必须先选择 signed_required 或 public_allowed/);
  assert.equal(upserts.length, 0);
});

test('admin tool-provider route: 历史 URL 源仍可通过 API 编辑非清单字段', async () => {
  const upserts: ToolProvider[] = [];
  const old = historicalProvider();
  const res = new FakeResponse();
  await handleAdminToolProviderApiFor(
    deps(old, upserts),
    'POST',
    '/admin/api/tool-providers',
    request({
      name: old.name,
      base_url: old.base_url,
      spec_source: 'url',
      spec_url: old.spec_url,
      description: 'new description',
    }),
    res as unknown as ServerResponse,
    { kind: 'admin', via: 'token' },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0]?.description, 'new description');
  assert.equal(upserts[0]?.spec_access_policy, 'legacy_unverified');
});
