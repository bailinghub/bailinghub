import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { KernelIdentityProviderV1 } from '../kernel-api/v1/contracts';
import { createBailingHubKernel } from './kernel';

function kernelConfig(dir: string, displayTz = 'Asia/Shanghai', label = '北京时间'): AppConfig {
  return {
    root: process.cwd(),
    env: 'development',
    server: { host: '127.0.0.1', port: 0, token: '' },
    brand: { name: 'BailingHub Test' },
    displayTz,
    displayTzLabel: label,
    auditRetentionDays: 0,
    alerts: null,
    metrics: { enabled: false, token: '', scrapeTimeoutMs: 1000 },
    bootstrapAdmin: null,
    concurrency: 1,
    killSwitchFile: join(dir, '.paused'),
    claudeBin: 'claude',
    defaultProfile: 'readonly',
    brainDir: join(dir, 'brain'),
    state: {
      backend: 'jsonl',
      jsonlPath: join(dir, 'jobs.jsonl'),
      mysql: { host: '', port: 3306, database: '', user: '', password: '', connectionLimit: 2 },
    },
    projects: {},
    llmCredentials: {},
    executor: { hubUrl: '', token: '', executorId: 'test', targets: [], waitMs: 100, concurrency: 1, labels: [] },
  };
}

test('Kernel API v1: OSS standalone server 走 Kernel 装配且 close 幂等', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bailinghub-kernel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const kernel = createBailingHubKernel({
    instanceKey: 'test:standalone',
    config: kernelConfig(dir),
    schedulerMode: 'standalone',
  });
  let exitCode: number | null = null;
  const server = kernel.createStandaloneServer({ exit: (code) => { exitCode = code; } });

  await server.start();
  const address = server.server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.status, 'ok');

  await server.shutdown('test');
  await kernel.close();
  assert.equal(exitCode, 0);
  assert.equal(kernel.isClosing(), true);
});

test('Kernel API v1: 当前版本拒绝同进程混用不同展示时区', async (t) => {
  const oneDir = mkdtempSync(join(tmpdir(), 'bailinghub-kernel-one-'));
  const twoDir = mkdtempSync(join(tmpdir(), 'bailinghub-kernel-two-'));
  t.after(() => {
    rmSync(oneDir, { recursive: true, force: true });
    rmSync(twoDir, { recursive: true, force: true });
  });
  const one = createBailingHubKernel({ instanceKey: 'tenant:one', config: kernelConfig(oneDir) });
  const two = createBailingHubKernel({ instanceKey: 'tenant:two', config: kernelConfig(twoDir, 'UTC', 'UTC') });

  await one.initialize();
  await assert.rejects(two.initialize(), /必须使用相同 display_tz/);

  await Promise.all([one.close(), two.close()]);
});

test('Kernel API v1: 返回值不泄露 composition/engine 内部对象', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bailinghub-kernel-public-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const kernel = createBailingHubKernel({ instanceKey: 'tenant:public', config: kernelConfig(dir) });
  assert.equal(Object.hasOwn(kernel, 'composition'), false);
  assert.equal(Object.hasOwn(kernel, 'engine'), false);
  await kernel.close(100);
});

test('Kernel API v1: runtimeRoot 自动隔离历史默认暂停文件且保留显式自定义', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bailinghub-kernel-runtime-root-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtimeRoot = join(dir, 'tenant-runtime');
  const defaultConfig = kernelConfig(dir);
  defaultConfig.runtimeRoot = runtimeRoot;
  defaultConfig.killSwitchFile = join(defaultConfig.root, '.paused');
  const rebased = createBailingHubKernel({ instanceKey: 'tenant:runtime-root', config: defaultConfig });
  assert.equal(rebased.config.killSwitchFile, join(runtimeRoot, '.paused'));
  assert.equal(defaultConfig.killSwitchFile, join(defaultConfig.root, '.paused'), '不修改宿主传入对象');

  const customConfig = kernelConfig(dir);
  customConfig.runtimeRoot = runtimeRoot;
  customConfig.killSwitchFile = join(dir, 'operator-owned.pause');
  const custom = createBailingHubKernel({ instanceKey: 'tenant:custom-pause', config: customConfig });
  assert.equal(custom.config.killSwitchFile, customConfig.killSwitchFile);

  await Promise.all([rebased.close(100), custom.close(100)]);
});

test('Kernel API v1: runtimeRoot 拒绝空值和相对路径并规范化绝对路径', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bailinghub-kernel-runtime-root-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const runtimeRoot of ['', '   ', 'tenant-runtime']) {
    const config = kernelConfig(dir);
    config.runtimeRoot = runtimeRoot;
    assert.throws(
      () => createBailingHubKernel({ instanceKey: `runtime-root:${runtimeRoot || 'empty'}`, config, schedulerMode: 'managed' }),
      /runtimeRoot 必须是非空绝对路径/,
    );
  }

  const config = kernelConfig(dir);
  config.runtimeRoot = `${dir}/nested/../tenant-runtime`;
  const kernel = createBailingHubKernel({ instanceKey: 'runtime-root:absolute', config, schedulerMode: 'managed' });
  assert.equal(kernel.config.runtimeRoot, join(dir, 'tenant-runtime'));
  assert.notEqual(kernel.config, config);
  await kernel.close(100);
});

test('Kernel API v1: HTTP drain 超时保留在途资源，请求收尾后可重试 close', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bailinghub-kernel-request-drain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let entered!: () => void;
  const requestEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const identityProvider: KernelIdentityProviderV1 = {
    async authenticate() {
      return { kind: 'admin', via: 'session', username: 'host-user', permissions: ['*'] };
    },
    async handleLogin(_req, res) {
      entered();
      await gate;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  };
  const kernel = createBailingHubKernel({
    instanceKey: 'tenant:request-drain',
    config: kernelConfig(dir),
    identityProvider,
    bootstrapLocalAdmin: false,
  });
  const server = createServer((req, res) => {
    void kernel.handle(req, res).catch((error) => res.destroy(error as Error));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = fetch(`http://127.0.0.1:${address.port}/admin/login`, { method: 'POST' });
  await requestEntered;

  await assert.rejects(kernel.close(5), /request drain timed out/);
  release();
  assert.equal((await response).status, 200);
  await kernel.close(100);
  assert.equal(kernel.isClosing(), true);
});

test('Kernel API v1: close 开始后拒绝新 initialize，避免关闭期重开资源', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bailinghub-kernel-init-close-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const kernel = createBailingHubKernel({ instanceKey: 'tenant:init-close', config: kernelConfig(dir) });

  const closing = kernel.close(100);
  await assert.rejects(kernel.initialize(), /is closing/);
  await closing;
});

test('Kernel API v1: close drainMs 拒绝负数、非整数和非有限值', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bailinghub-kernel-close-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const kernel = createBailingHubKernel({ instanceKey: 'tenant:close-budget', config: kernelConfig(dir) });

  for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 600_001]) {
    await assert.rejects(kernel.close(invalid), /safe integer between 0 and 600000/);
    assert.equal(kernel.isClosing(), false);
  }
  await kernel.close(100);
});
