import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { signToolCall } from '../core/contracts/tools';
import { demoToolSpec } from './demo-dataset';

const serverPath = fileURLToPath(new URL('../../demo/business/server.mjs', import.meta.url));
const strongSecret = '4f7b2c91a8d03e65b49c27e018f3d6aa';

async function unusedPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitUntilReady(child: ChildProcess, baseUrl: string, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`demo business 提前退出 (${child.exitCode}): ${stderr()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // 子进程刚启动时连接拒绝属于正常竞态，短暂重试。
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`demo business 启动超时: ${stderr()}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

function signedHeaders(
  method: string,
  pathWithQuery: string,
  body: string,
  subject = 'demo-user-001',
  jobId = 'contract-test',
  signingSecret = strongSecret,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'content-type': 'application/json',
    'x-bailing-timestamp': String(timestamp),
    'x-bailing-signature': signToolCall(signingSecret, timestamp, method, pathWithQuery, body, subject, jobId),
    'x-bailing-on-behalf-of': subject,
    'x-bailing-job-id': jobId,
  };
}

test('demo business stateless-readonly: 只暴露签名只读工具，不暴露或积累可变状态', { timeout: 10_000 }, async () => {
  const port = await unusedPort();
  let stderr = '';
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DEMO_HOST: '127.0.0.1',
      DEMO_PORT: String(port),
      DEMO_PROFILE: 'stateless-readonly',
      DEMO_TOOL_SECRET: strongSecret,
      // 即使这两项是无效值，只读 profile 也不应触达 Hub 或 client token 路径。
      DEMO_HUB_URL: 'http://127.0.0.1:1',
      DEMO_CLIENT_TOKEN: 'must-not-be-used',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitUntilReady(child, baseUrl, () => stderr);

    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { ok: true, app: 'demo-business', profile: 'stateless-readonly' });

    const rootResponse = await fetch(`${baseUrl}/`);
    assert.equal(rootResponse.status, 200);
    const root = await rootResponse.text();
    assert.doesNotMatch(root, new RegExp('批准|拒绝|authorization: Bearer|/console/'));

    const specResponse = await fetch(`${baseUrl}/.well-known/bailing/tools.json`);
    assert.equal(specResponse.status, 200);
    const spec = await specResponse.json();
    assert.deepEqual(spec, demoToolSpec('stateless-readonly'));
    assert.deepEqual(Object.keys((spec as { paths: object }).paths).sort(), ['/failure-demo', '/orders']);

    const probeBody = JSON.stringify({ subject: 'demo-user-001' });
    const probePath = '/.well-known/bailing/authz-probe';
    const probeResponse = await fetch(`${baseUrl}${probePath}`, {
      method: 'POST',
      headers: signedHeaders('POST', probePath, probeBody, 'demo-user-001', 'probe-test'),
      body: probeBody,
    });
    assert.equal(probeResponse.status, 200);
    assert.deepEqual(await probeResponse.json(), { authorized: true, subject: 'demo-user-001' });

    const orderPath = '/orders?order_no=SO-1001';
    const orderResponse = await fetch(`${baseUrl}${orderPath}`, {
      headers: signedHeaders('GET', orderPath, ''),
    });
    assert.equal(orderResponse.status, 200);
    const orderResult = await orderResponse.json() as { subject: string; orders: Array<{ order_no: string }> };
    assert.equal(orderResult.subject, 'demo-user-001');
    assert.deepEqual(orderResult.orders.map((order) => order.order_no), ['SO-1001']);

    const failurePath = '/failure-demo';
    const failureResponse = await fetch(`${baseUrl}${failurePath}`, {
      headers: signedHeaders('GET', failurePath, ''),
    });
    assert.equal(failureResponse.status, 500);

    const mutableRequests: Array<[string, RequestInit]> = [
      ['/api/state', {}],
      ['/tickets', { method: 'POST', body: '{}' }],
      ['/refunds', { method: 'POST', body: '{}' }],
      ['/approvals', { method: 'POST', body: '{}' }],
      ['/api/approvals/1/decision', { method: 'POST', body: 'decision=approved' }],
    ];
    for (const [path, init] of mutableRequests) {
      const response = await fetch(`${baseUrl}${path}`, init);
      assert.equal(response.status, 404, `${path} 在 stateless-readonly 下必须隐藏`);
    }
  } finally {
    await stop(child);
  }
});

test('demo business 默认 profile 保持 full-local 工单与状态演示能力', { timeout: 10_000 }, async () => {
  const port = await unusedPort();
  let stderr = '';
  const env = { ...process.env };
  delete env.DEMO_PROFILE;
  delete env.DEMO_TOOL_SECRET;
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...env,
      DEMO_HOST: '127.0.0.1',
      DEMO_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitUntilReady(child, baseUrl, () => stderr);
    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.deepEqual(await healthResponse.json(), { ok: true, app: 'demo-business', profile: 'full-local' });

    const specResponse = await fetch(`${baseUrl}/.well-known/bailing/tools.json`);
    assert.deepEqual(await specResponse.json(), demoToolSpec('full-local'));

    const ticketPath = '/tickets';
    const ticketBody = JSON.stringify({ order_no: 'SO-1001', title: '需要人工跟进', message: '本地完整 demo 回归' });
    const ticketResponse = await fetch(`${baseUrl}${ticketPath}`, {
      method: 'POST',
      headers: signedHeaders('POST', ticketPath, ticketBody, 'demo-user-001', 'full-local-test', 'demo-tool-secret-change-me'),
      body: ticketBody,
    });
    assert.equal(ticketResponse.status, 200);

    const stateResponse = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json() as { tickets: Array<{ order_no: string }> };
    assert.deepEqual(state.tickets.map((ticket) => ticket.order_no), ['SO-1001']);
  } finally {
    await stop(child);
  }
});

test('demo business stateless-readonly: 弱密钥和占位符启动时 fail-fast', () => {
  const weakSecrets = [
    'short-secret',
    '                        ',
    'demo-tool-secret-change-me',
    'test-secret-that-is-long-enough',
    'example-secret-that-is-long-enough',
    'change-this-secret-right-now',
    'replace-this-secret-right-now',
    'REPLACE_WITH_32_BYTE_INDEPENDENT_DEMO_TOOL_SECRET',
  ];
  for (const weakSecret of weakSecrets) {
    const result = spawnSync(process.execPath, [serverPath], {
      env: {
        ...process.env,
        DEMO_HOST: '127.0.0.1',
        DEMO_PORT: '0',
        DEMO_PROFILE: 'stateless-readonly',
        DEMO_TOOL_SECRET: weakSecret,
      },
      encoding: 'utf8',
      timeout: 2_000,
    });
    assert.notEqual(result.status, 0, `弱密钥 ${weakSecret} 不应启动成功`);
    assert.match(result.stderr, /DEMO_TOOL_SECRET 不安全/);
  }
});

test('demo business stateless-readonly: 拒绝绑定非回环地址', () => {
  const result = spawnSync(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DEMO_HOST: '0.0.0.0',
      DEMO_PORT: '0',
      DEMO_PROFILE: 'stateless-readonly',
      DEMO_TOOL_SECRET: strongSecret,
    },
    encoding: 'utf8',
    timeout: 2_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEMO_HOST 必须是本机回环地址/);
});
