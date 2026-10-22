import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { Job } from '../core/contracts/types';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import { TOOL_ARGUMENTS_MAX_BYTES, TOOL_INVOCATION_BODY_MAX_BYTES } from '../core/contracts/tool-input-limits';
import { handleToolInvokeFor, type ToolProxyDeps } from './tool-proxy';

class Response {
  statusCode = 0;
  body: Record<string, unknown> = {};
  writeHead(status: number): void { this.statusCode = status; }
  end(value: string): void { this.body = JSON.parse(value) as Record<string, unknown>; }
}

function fixture() {
  const serverToken = 'demo-server-token';
  const job = { job_id: 'demo-job', request_id: 'demo-request', status: 'dispatched',
    claim_token: 'demo-claim', metadata: {}, dispatch: {} } as Job;
  const deps: ToolProxyDeps = {
    cfg: { server: { token: serverToken } } as AppConfig, configStore: null,
    stateStore: { getJob: async () => job } as unknown as RuntimeStateStore,
    toolIndex: null, now: () => '2026-01-01T00:00:00.000Z', sleep: async () => undefined,
  };
  const token = createHmac('sha256', serverToken).update(`${job.job_id}.${job.claim_token}`).digest('hex');
  return { deps, job, token };
}

async function invoke(body: unknown, presented?: string) {
  const fx = fixture(), res = new Response();
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  await handleToolInvokeFor(fx.deps, req, res as unknown as ServerResponse, fx.job.job_id, presented ?? fx.token);
  return res;
}

function argsOfBytes(bytes: number): Record<string, unknown> {
  const base = { source: { html: '中文😀"\\', css: '' }, padding: '' };
  base.padding = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(base), 'utf8'));
  assert.equal(Buffer.byteLength(JSON.stringify(base), 'utf8'), bytes);
  return base;
}

test('Executor tool proxy: 1 MiB arguments reach normal governance without the old envelope rejection', async () => {
  for (const bytes of [4395, 5183, 16 * 1024, 64 * 1024, 256 * 1024, TOOL_ARGUMENTS_MAX_BYTES]) {
    const response = await invoke({ tool: 'validate_page', arguments: argsOfBytes(bytes) });
    // This fixture deliberately has no provider. The size gate must not replace normal governance.
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, '该任务未配置工具');
  }
});

test('Executor tool proxy: exact serialized arguments budget rejects +1 with no payload echo', async () => {
  const response = await invoke({ tool: 'validate_page', arguments: argsOfBytes(TOOL_ARGUMENTS_MAX_BYTES + 1) });
  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.body, {
    error: 'arguments_too_large', origin: 'core', dispatch: 'not_dispatched',
    limit_scope: 'arguments', actual_bytes: 1048577, max_bytes: 1048576,
  });
});

test('Executor tool proxy: oversized HTTP body keeps 413 instead of becoming tool-required 400', async () => {
  const response = await invoke({ tool: 'validate_page', arguments: {}, padding: 'x'.repeat(TOOL_INVOCATION_BODY_MAX_BYTES) });
  assert.equal(response.statusCode, 413);
  assert.equal(response.body.error, 'arguments_too_large');
  assert.equal(response.body.limit_scope, 'request_body');
  assert.equal(response.body.max_bytes, 2097152);
  assert.equal(response.body.dispatch, 'not_dispatched');
  assert.ok(Number(response.body.observed_bytes) > TOOL_INVOCATION_BODY_MAX_BYTES);
});

test('Executor tool proxy: authentication still precedes size reads and invalid bodies stay invalid', async () => {
  assert.equal((await invoke({ arguments: argsOfBytes(TOOL_ARGUMENTS_MAX_BYTES + 1) }, 'demo-invalid-token')).statusCode, 401);
  for (const body of [null, [], 'text']) {
    const response = await invoke(body);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, 'invalid_request');
  }
});
