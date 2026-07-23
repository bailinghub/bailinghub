import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHubSmoke, type SmokeRequestResult } from './smoke-runtime';

test('runHubSmoke: demo route 跑通 /run、终态、trace 与脱敏排障包', async () => {
  const calls: string[] = [];
  let runBody: unknown;
  const got = await runHubSmoke({
    hub: 'http://hub.local',
    adminToken: 'admin-token',
    runRoute: 'demo_support',
    runToken: 'demo-token',
    pollMs: 1,
    request: async (method, path, opts): Promise<SmokeRequestResult> => {
      calls.push(`${method} ${path}`);
      if (path === '/health') return { status: 200, json: { status: 'ok' }, text: '{"status":"ok"}' };
      if (path === '/console/') return { status: 200, json: null, text: '<div id="app"></div>' };
      if (path === '/schemas/config/route.schema.json') return { status: 200, json: { title: 'Route' }, text: '{"title":"Route"}' };
      if (path === '/admin/api/version') return { status: 200, json: { app: { name: 'bailinghub' } }, text: '{}' };
      if (path === '/admin/api/config-diagnostics') return { status: 200, json: { errors: 0, diagnostics: [] }, text: '{}' };
      if (path === '/admin/api/routes/auto-preview') return { status: 200, json: { rows: [] }, text: '{}' };
      if (path === '/run') {
        runBody = opts?.body;
        return { status: 202, json: { job_id: 'job-1' }, text: '{}' };
      }
      if (path === '/jobs/job-1') return { status: 200, json: { status: 'done' }, text: '{}' };
      if (path.startsWith('/admin/api/runs/trace?')) {
        return { status: 200, json: { debug_bundle: { redaction: { applied: true }, diagnosis: [{ code: 'ok' }] } }, text: '{}' };
      }
      return { status: 404, json: {}, text: 'not found' };
    },
  });

  assert.equal(got.fail, 0);
  assert.equal(got.run?.route, 'demo_support');
  assert.equal(got.run?.status, 'done');
  assert.ok(calls.includes('POST /run'));
  assert.equal((runBody as Record<string, unknown>)['source'], undefined);
  assert.ok(calls.some((x) => x.startsWith('GET /admin/api/runs/trace?request_id=')));
  assert.ok(got.checks.some((c) => c.name === 'debug_bundle 默认脱敏' && c.status === 'pass'));
});

test('runHubSmoke: 支持用当前后台 Cookie 验证管理 API', async () => {
  const adminCalls: Array<{ path: string; headers?: Record<string, string> }> = [];
  const got = await runHubSmoke({
    hub: 'http://hub.local',
    adminHeaders: { cookie: 'bz_sess=s1; bz_tenant=tenant_a' },
    tenantId: 'tenant_a',
    request: async (_method, path, opts): Promise<SmokeRequestResult> => {
      if (path === '/health') return { status: 200, json: { status: 'ok' }, text: '{"status":"ok"}' };
      if (path === '/console/') return { status: 200, json: null, text: '<div id="app"></div>' };
      if (path === '/schemas/config/route.schema.json') return { status: 200, json: { title: 'Route' }, text: '{"title":"Route"}' };
      if (path.startsWith('/admin/api/')) adminCalls.push({ path, headers: opts?.headers });
      if (path === '/admin/api/version?tenant=tenant_a') return { status: 200, json: { app: { name: 'bailinghub' } }, text: '{}' };
      if (path === '/admin/api/config-diagnostics?tenant=tenant_a') return { status: 200, json: { errors: 0, diagnostics: [] }, text: '{}' };
      if (path === '/admin/api/routes/auto-preview?tenant=tenant_a') return { status: 200, json: { rows: [] }, text: '{}' };
      return { status: 404, json: {}, text: 'not found' };
    },
  });

  assert.equal(got.fail, 0);
  assert.ok(got.checks.some((c) => c.name === '版本 API 可访问' && c.status === 'pass'));
  assert.ok(adminCalls.length >= 3);
  assert.ok(adminCalls.every((c) => c.headers?.cookie === 'bz_sess=s1; bz_tenant=tenant_a'));
});
