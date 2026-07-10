import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { debugInvokeTool } from './tool-debug';
import type { ToolDefinition } from '../core/contracts/tool-definition';
import type { ToolProvider } from '../core/contracts/types';

function provider(baseUrl: string): ToolProvider {
  return {
    name: 'demo',
    base_url: baseUrl,
    spec_source: 'inline',
    secret: 'debug-secret',
    log_payload: true,
    timeout_ms: 3000,
    rate_limit_per_min: 0,
    auto_refresh_min: 0,
    enabled: true,
  };
}

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    schemaVersion: 'bailing.tool-definition.v1',
    name: 'staff_update',
    source: 'openapi',
    method: 'POST',
    path: '/stores/{store_id}/staff/{staff_id}',
    description: '更新员工资料',
    scope: 'tenant.staff.write',
    risk: 'medium',
    confirmRequired: false,
    rateLimitPerMin: 0,
    requiresSubject: true,
    sensitive: false,
    readonly: false,
    idempotent: false,
    timeoutMs: 3000,
    confirmPrompt: '',
    context: [],
    extensions: {},
    inputSchema: { type: 'object', properties: {} },
    paramIn: { store_id: 'path', staff_id: 'path', tenant: 'header', dry_run: 'query', name: 'body' },
    ...overrides,
  };
}

test('debugInvokeTool: 按 ToolDefinition.paramIn 组装请求并脱敏签名头', async () => {
  let captured: any = null;
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      captured = { url: req.url, method: req.method, headers: req.headers, body };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    const result = await debugInvokeTool({
      provider: provider(baseUrl),
      tool: tool(),
      args: { store_id: 's 1', staff_id: 'u/2', tenant: 't1', dry_run: true, name: '张三' },
      onBehalfOf: 't1:u1',
      jobId: 'job-debug',
      clientAppId: 'admin',
    });

    assert.equal(result.ok, true);
    assert.equal(result.request.path_with_query, '/stores/s%201/staff/u%2F2?dry_run=true');
    assert.equal(result.request.headers['x-bailing-signature'], 'sha256=[REDACTED]');
    assert.equal(result.request.signature_material.method, 'POST');
    assert.equal(result.request.signature_material.path_with_query, '/stores/s%201/staff/u%2F2?dry_run=true');
    assert.match(result.request.signature_material.body_sha256, /^[a-f0-9]{64}$/);
    assert.equal(captured.method, 'POST');
    assert.equal(captured.url, '/stores/s%201/staff/u%2F2?dry_run=true');
    assert.equal(captured.headers['tenant'], 't1');
    assert.equal(captured.headers['x-bailing-on-behalf-of'], 't1:u1');
    assert.equal(JSON.parse(captured.body).name, '张三');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('debugInvokeTool: 高风险或需确认工具默认阻断，不发起 HTTP 调用', async () => {
  let hit = false;
  const server = createServer((_req, res) => {
    hit = true;
    res.end('unexpected');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  try {
    const result = await debugInvokeTool({
      provider: provider(`http://127.0.0.1:${addr.port}`),
      tool: tool({ risk: 'high', confirmRequired: true, requiresSubject: false }),
      args: { store_id: 's1', staff_id: 'u1' },
    });

    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.equal(hit, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
