import test from 'node:test';
import assert from 'node:assert/strict';
import { send } from './http';
import { createBailingHttpServer } from './http-server';
import type { AppConfig } from '../core/config/config';

test('createBailingHttpServer 使用注入的 HTTP handler、生命周期和停机 drain', async () => {
  let initialized = false;
  let stopped = false;
  let privateCalled = false;
  let drainedMs = 0;
  let exitCode: number | null = null;
  const bootTimer = setTimeout(() => undefined, 60_000);
  bootTimer.unref();

  const app = createBailingHttpServer({
    cfg: {
      server: { host: '127.0.0.1', port: 0 },
      state: { backend: 'memory' },
      concurrency: 1,
      displayTz: 'Asia/Shanghai',
    } as unknown as AppConfig,
    configStore: null,
    queue: {
      async drain(ms: number) {
        drainedMs = ms;
        return true;
      },
    },
    async handlePublicHttp(_req, res, url) {
      if (url.pathname !== '/health') return false;
      send(res, 200, { ok: true });
      return true;
    },
    async handlePrivateHttp() {
      privateCalled = true;
    },
    async initializeRuntimeLifecycle() {
      initialized = true;
    },
    startRuntimeSchedulers() {
      return {
        stop() {
          stopped = true;
        },
      };
    },
    scheduleBootRecovery() {
      return bootTimer;
    },
    shutdownDrainMs: 17,
    logger: { log() {}, warn() {}, error() {} },
    exit(code) {
      exitCode = code;
    },
  });

  await app.start();
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(initialized, true);
  assert.equal(privateCalled, false);

  await app.shutdown('test');
  assert.equal(stopped, true);
  assert.equal(drainedMs, 17);
  assert.equal(exitCode, 0);
});

test('createBailingHttpServer 不向调用方泄露未捕获异常细节', async () => {
  const errors: unknown[][] = [];
  const app = createBailingHttpServer({
    cfg: {
      server: { host: '127.0.0.1', port: 0 },
      state: { backend: 'memory' },
      concurrency: 1,
      displayTz: 'Asia/Shanghai',
    } as unknown as AppConfig,
    configStore: null,
    queue: { async drain() { return true; } },
    async handlePublicHttp() {
      throw new Error('mysql://admin:secret@db.internal/private');
    },
    async handlePrivateHttp() {},
    async initializeRuntimeLifecycle() {},
    startRuntimeSchedulers() { return { stop() {} }; },
    scheduleBootRecovery() {
      const timer = setTimeout(() => undefined, 60_000);
      timer.unref();
      return timer;
    },
    logger: { log() {}, warn() {}, error(...args) { errors.push(args); } },
    exit() {},
  });

  await app.start();
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/explode`);
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 500);
  assert.equal(body.error, 'internal_error');
  assert.match(String(body.request_id), /^[0-9a-f-]{36}$/);
  assert.equal(response.headers.get('x-request-id'), body.request_id);
  assert.doesNotMatch(JSON.stringify(body), /secret|db\.internal|private/);
  assert.match(JSON.stringify(errors), /db\.internal/);

  await app.shutdown('test');
});
