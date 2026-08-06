import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDedicatedAuthzProbe, dedicatedAuthzProbeTarget, refreshProviderSpecFor } from './tool-specs';
import type { AppConfig } from '../core/config/config';
import type { ToolProvider } from '../core/contracts/types';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

const NOW = '2026-08-05T06:00:00.000Z';
const SPEC = JSON.stringify({ openapi: '3.0.0', info: { title: 'tools', version: '1' }, paths: {} });
const CHANGED_SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'tools', version: '2' },
  paths: {
    '/orders': {
      get: {
        operationId: 'list_orders',
        summary: '查询订单',
        'x-agent-capability': { version: 1, enabled: true, scope: 'orders.read' },
      },
    },
  },
});

function provider(policy: NonNullable<ToolProvider['spec_access_policy']>): ToolProvider {
  return {
    name: 'orders',
    base_url: 'https://business.example.com',
    spec_source: 'url',
    spec_access_policy: policy,
    spec_url: 'https://business.example.com/bailing/tools.json',
    spec_json: SPEC,
    secret: 'provider-secret',
    log_payload: false,
    timeout_ms: 10_000,
    rate_limit_per_min: 60,
    auto_refresh_min: 0,
    enabled: true,
  };
}

function harness(p: ToolProvider, legacyRepository = false) {
  const probes: NonNullable<ToolProvider['spec_access_probe']>[] = [];
  const upserts: ToolProvider[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const config = {
    toolProviders: {
      async upsert(next: ToolProvider) { upserts.push(next); },
      ...(legacyRepository ? {} : {
        async updateSpecAccessProbe(_name: string, probe: NonNullable<ToolProvider['spec_access_probe']>) { probes.push(probe); },
      }),
    },
    alertRules: { async matching() { return []; } },
  } as unknown as ConfigStoreContract;
  const state = { async appendAudit(entry: Record<string, unknown>) { audits.push(entry); } } as unknown as RuntimeStateStore;
  const cfg = {
    server: { host: '127.0.0.1', port: 18900, token: 'server-token' },
    brand: { name: 'BailingHub' },
    alerts: null,
  } as unknown as AppConfig;
  const refresh = () => refreshProviderSpecFor(config, state, null, p, 'manual', cfg, () => NOW, async () => undefined);
  return { probes, upserts, audits, refresh };
}

function installFetch(
  t: { after(fn: () => void): void },
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
}

function cancelTrackedResponse(status: number): { response: Response; canceled: () => boolean } {
  let wasCanceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"ignored":true}')); },
    cancel() { wasCanceled = true; },
  });
  return { response: new Response(body, { status }), canceled: () => wasCanceled };
}

test('dedicatedAuthzProbeTarget: 支持 root 声明专用授权探针', () => {
  const spec = JSON.stringify({
    openapi: '3.0.0',
    'x-bailing-authz-probe': { method: 'POST', path: '/.well-known/bailing/authz-probe', operationId: 'checkAuthz' },
    paths: {},
  });
  assert.deepEqual(dedicatedAuthzProbeTarget(spec), {
    method: 'POST',
    path: '/.well-known/bailing/authz-probe',
    name: 'checkAuthz',
  });
});

test('dedicatedAuthzProbeTarget: 支持 operation 标记专用授权探针', () => {
  const spec = JSON.stringify({
    openapi: '3.0.0',
    paths: {
      '/bailing/authz-probe': {
        get: { operationId: 'authzProbe', 'x-bailing-authz-probe': true },
      },
    },
  });
  assert.deepEqual(dedicatedAuthzProbeTarget(spec), {
    method: 'GET',
    path: '/bailing/authz-probe',
    name: 'authzProbe',
  });
});

test('classifyDedicatedAuthzProbe: 专用探针按授权布尔结论分类', () => {
  assert.equal(classifyDedicatedAuthzProbe(200, '{"authorized":false}', 'probe').status, 'pass');
  assert.equal(classifyDedicatedAuthzProbe(200, '{"allow":true}', 'probe').status, 'suspect');
  assert.equal(classifyDedicatedAuthzProbe(403, '', 'probe').status, 'pass');
  assert.equal(classifyDedicatedAuthzProbe(200, '{}', 'probe').status, 'inconclusive');
});

test('signed_required: 正确签名成功且两个负向请求均被拒绝才应用 spec', async (t) => {
  const p = provider('signed_required');
  const h = harness(p);
  const unsigned = cancelTrackedResponse(401);
  const invalid = cancelTrackedResponse(403);
  const calls: Array<{ headers: Headers; redirect?: RequestInit['redirect'] }> = [];
  installFetch(t, async (_input, init) => {
    calls.push({ headers: new Headers(init?.headers), redirect: init?.redirect });
    if (calls.length === 1) return new Response(SPEC, { status: 200 });
    if (calls.length === 2) return unsigned.response;
    return invalid.response;
  });

  const result = await h.refresh();

  assert.deepEqual(result, { tools: 0, added: [], removed: [], changed: [] });
  assert.equal(calls.length, 3);
  assert.match(calls[0]!.headers.get('x-bailing-signature') ?? '', /^sha256=[0-9a-f]{64}$/);
  assert.equal(calls[1]!.headers.get('x-bailing-signature'), null);
  assert.equal(calls[2]!.headers.get('x-bailing-signature'), `sha256=${'0'.repeat(64)}`);
  assert.deepEqual(calls.map((call) => call.redirect), ['manual', 'manual', 'manual']);
  assert.equal(unsigned.canceled(), true);
  assert.equal(invalid.canceled(), true);
  assert.deepEqual(h.probes, [{
    status: 'protected', signed_http: 200, unsigned_http: 401, invalid_http: 403,
    reason: '正确签名可读取，未签名与坏签请求均被拒绝', at: NOW,
  }]);
  assert.equal(h.upserts.length, 1);
  assert.equal(h.upserts[0]!.spec_access_probe?.status, 'protected');
  assert.equal(h.audits.length, 1);
  assert.deepEqual(h.audits[0], {
    ts: NOW,
    job_id: '-',
    request_id: 'tools',
    event: 'spec_access_probe',
    detail: {
      provider: 'orders',
      policy: 'signed_required',
      status: 'protected',
      signed_http: 200,
      unsigned_http: 401,
      invalid_http: 403,
      reason: '正确签名可读取，未签名与坏签请求均被拒绝',
    },
  });
});

test('signed_required: 任一负向请求返回 2xx 时记录 public、保留旧缓存并拒绝更新', async (t) => {
  const p = provider('signed_required');
  p.spec_url = 'https://business.example.com/bailing/tools.json?token=must-not-be-audited';
  const h = harness(p);
  const unsigned = cancelTrackedResponse(200);
  const invalid = cancelTrackedResponse(403);
  let call = 0;
  installFetch(t, async () => {
    call++;
    if (call === 1) return new Response(CHANGED_SPEC, { status: 200 });
    return call === 2 ? unsigned.response : invalid.response;
  });

  await assert.rejects(h.refresh(), /仅签名可读.*保留旧缓存/);

  assert.equal(call, 3, '两个负向请求都必须执行');
  assert.equal(unsigned.canceled(), true);
  assert.equal(invalid.canceled(), true);
  assert.equal(h.probes.length, 1);
  assert.equal(h.probes[0]!.status, 'public');
  assert.equal(h.probes[0]!.unsigned_http, 200);
  assert.equal(h.probes[0]!.invalid_http, 403);
  assert.equal(h.upserts.length, 0, '访问策略失败不得覆盖旧 spec 缓存');
  assert.equal(p.spec_json, SPEC);
  const auditJson = JSON.stringify(h.audits);
  assert.match(auditJson, /spec_access_probe/);
  assert.doesNotMatch(auditJson, /must-not-be-audited|provider-secret|business\.example\.com/);
});

test('signed_required: 429/5xx/网络类负向结果记 inconclusive 并 fail closed', async (t) => {
  const p = provider('signed_required');
  const h = harness(p);
  let call = 0;
  installFetch(t, async () => {
    call++;
    if (call === 1) return new Response(CHANGED_SPEC, { status: 200 });
    if (call === 2) return new Response('', { status: 429 });
    return new Response('', { status: 404 });
  });

  await assert.rejects(h.refresh(), /无法确认访问保护.*保留旧缓存/);

  assert.equal(h.probes.length, 1);
  assert.deepEqual({
    status: h.probes[0]!.status,
    signed_http: h.probes[0]!.signed_http,
    unsigned_http: h.probes[0]!.unsigned_http,
    invalid_http: h.probes[0]!.invalid_http,
  }, { status: 'inconclusive', signed_http: 200, unsigned_http: 429, invalid_http: 404 });
  assert.equal(h.upserts.length, 0);
});

test('public_allowed: 只做无签拉取并明确记录 public', async (t) => {
  const p = provider('public_allowed');
  const h = harness(p);
  const calls: Array<{ headers: Headers; redirect?: RequestInit['redirect'] }> = [];
  installFetch(t, async (_input, init) => {
    calls.push({ headers: new Headers(init?.headers), redirect: init?.redirect });
    return new Response(SPEC, { status: 200 });
  });

  await h.refresh();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.headers.get('x-bailing-signature'), null);
  assert.equal(calls[0]!.redirect, 'manual');
  assert.equal(h.probes[0]!.status, 'public');
  assert.equal(h.probes[0]!.unsigned_http, 200);
  assert.equal(h.upserts[0]!.spec_access_probe?.status, 'public');
});

test('legacy_unverified: 保持旧版签名拉取与重定向兼容并记录 skipped', async (t) => {
  const p = provider('legacy_unverified');
  const h = harness(p);
  const calls: Array<{ headers: Headers; redirect?: RequestInit['redirect'] }> = [];
  installFetch(t, async (_input, init) => {
    calls.push({ headers: new Headers(init?.headers), redirect: init?.redirect });
    return new Response(SPEC, { status: 200 });
  });

  await h.refresh();

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.headers.get('x-bailing-signature') ?? '', /^sha256=[0-9a-f]{64}$/);
  assert.equal(calls[0]!.redirect, 'follow');
  assert.equal(h.probes[0]!.status, 'skipped');
  assert.equal(h.probes[0]!.signed_http, 200);
});

test('旧扩展仓储缺少探针窄更新时回退 upsert 且不破坏刷新', async (t) => {
  const p = provider('signed_required');
  const h = harness(p, true);
  let call = 0;
  installFetch(t, async () => {
    call++;
    if (call === 1) return new Response(SPEC, { status: 200 });
    return new Response('', { status: call === 2 ? 401 : 403 });
  });

  await h.refresh();

  assert.equal(h.probes.length, 0);
  assert.equal(h.upserts.length, 2, '先用旧 upsert 持久化探针，再更新时间戳');
  assert.equal(h.upserts[0]!.spec_json, SPEC);
  assert.equal(h.upserts[0]!.spec_access_probe?.status, 'protected');
  assert.equal(h.upserts[1]!.spec_access_probe?.status, 'protected');
});

test('新访问策略拒绝重定向且在写缓存前持久化 inconclusive', async (t) => {
  const p = provider('signed_required');
  const h = harness(p);
  let redirect: RequestInit['redirect'];
  installFetch(t, async (_input, init) => {
    redirect = init?.redirect;
    return new Response('', { status: 302, headers: { location: 'https://other.example.com/spec.json' } });
  });

  await assert.rejects(h.refresh(), /禁止重定向/);

  assert.equal(redirect, 'manual');
  assert.equal(h.probes[0]!.status, 'inconclusive');
  assert.equal(h.probes[0]!.signed_http, 302);
  assert.equal(h.upserts.length, 0);
});

test('正向 Spec 响应超过 5 MiB 时有界拒绝且不覆盖缓存', async (t) => {
  const p = provider('signed_required');
  const h = harness(p);
  installFetch(t, async () => new Response('{}', {
    status: 200,
    headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
  }));

  await assert.rejects(h.refresh(), /超过 5242880 字节上限/);

  assert.equal(h.probes[0]!.status, 'inconclusive');
  assert.equal(h.probes[0]!.signed_http, 200);
  assert.equal(h.upserts.length, 0);
});

test('Spec 解析失败时已记录访问姿态但绝不覆盖旧缓存', async (t) => {
  const p = provider('signed_required');
  const h = harness(p);
  let call = 0;
  installFetch(t, async () => {
    call++;
    if (call === 1) return new Response('{bad spec', { status: 200 });
    return new Response('', { status: call === 2 ? 401 : 403 });
  });

  await assert.rejects(h.refresh(), /spec 不是合法 JSON 或 YAML/);

  assert.equal(h.probes[0]!.status, 'protected');
  assert.equal(h.audits[0]!['event'], 'spec_access_probe');
  assert.equal(h.upserts.length, 0);
  assert.equal(p.spec_json, SPEC);
});
