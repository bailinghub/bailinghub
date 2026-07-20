import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../core/config/config';
import { handlePublicHttpFor, type PublicHttpDeps } from './public';
import { handlePublicHttp } from './public-default';

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string | number | string[]> = {};
  body: Uint8Array = Buffer.alloc(0);

  writeHead(code: number, headers?: Record<string, string | number | string[]>): void {
    this.statusCode = code;
    if (headers) Object.assign(this.headers, headers);
  }

  setHeader(name: string, value: string | number | string[]): void {
    this.headers[name.toLowerCase()] = value;
  }

  end(chunk?: string | Buffer): void {
    if (chunk) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }
}

function req(method: string): IncomingMessage {
  return { method } as IncomingMessage;
}

test('public route: For 入口使用注入的运行期状态生成 health', async () => {
  const deps: PublicHttpDeps = {
    cfg: { root: process.cwd(), state: { backend: 'memory' } } as unknown as AppConfig,
    configStore: null,
    queue: { stats: () => ({ running: 7, waiting: 3 }) },
    isPaused: () => true,
    operationalStatus: () => ({ audit_write_failures: 2, last_audit_failure_at: '2026-07-10T08:00:00.000Z' }),
    serveConsole: (_path, res) => { res.writeHead(204); res.end(); },
    handleChat: async () => undefined,
    handleChatConfig: async () => undefined,
    handleChatEvents: async () => undefined,
    handleChatThread: async () => undefined,
    handleChatUpload: async () => undefined,
    handleChatRate: async () => undefined,
    serveChatDemo: (res) => { res.writeHead(204); res.end(); },
  };
  const res = new FakeResponse();
  const handled = await handlePublicHttpFor(deps, req('GET'), res as unknown as ServerResponse, new URL('http://local/health'));

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(Buffer.from(res.body).toString('utf8')) as Record<string, unknown>;
  assert.equal(body.paused, true);
  assert.deepEqual(body.queue, { running: 7, waiting: 3 });
  assert.equal(body.backend, 'memory');
  assert.equal(body.configBackend, false);
  assert.deepEqual(body.observability, { audit_write_failures: 2, last_audit_failure_at: '2026-07-10T08:00:00.000Z' });
});

test('public route: readiness 根据共享依赖状态返回 200/503 且不泄露内部错误', async () => {
  const base: PublicHttpDeps = {
    cfg: { root: process.cwd(), state: { backend: 'mysql' } } as unknown as AppConfig,
    configStore: null,
    queue: { stats: () => ({}) },
    isPaused: () => false,
    readiness: async () => ({ ready: false, checks: { database: 'failed', migrations: { status: 'failed', pending: 0 } } }),
    serveConsole: (_path, res) => { res.writeHead(204); res.end(); },
    handleChat: async () => undefined,
    handleChatConfig: async () => undefined,
    handleChatEvents: async () => undefined,
    handleChatThread: async () => undefined,
    handleChatUpload: async () => undefined,
    handleChatRate: async () => undefined,
    serveChatDemo: (res) => { res.writeHead(204); res.end(); },
  };
  const failed = new FakeResponse();
  await handlePublicHttpFor(base, req('GET'), failed as unknown as ServerResponse, new URL('http://local/health/ready'));
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(JSON.parse(Buffer.from(failed.body).toString('utf8')), {
    status: 'not_ready', checks: { database: 'failed', migrations: { status: 'failed', pending: 0 } },
  });

  const ready = new FakeResponse();
  await handlePublicHttpFor({ ...base, readiness: async () => ({ ready: true, checks: { database: 'ok', migrations: { status: 'ok', pending: 0 } } }) }, req('GET'), ready as unknown as ServerResponse, new URL('http://local/health/ready'));
  assert.equal(ready.statusCode, 200);
});

test('public route: 聊天 SSE 事件端点走公开分发并带 CORS', async () => {
  let called = false;
  const deps: PublicHttpDeps = {
    cfg: { root: process.cwd(), state: { backend: 'memory' } } as unknown as AppConfig,
    configStore: null,
    queue: { stats: () => ({}) },
    isPaused: () => false,
    serveConsole: (_path, res) => { res.writeHead(204); res.end(); },
    handleChat: async () => undefined,
    handleChatConfig: async () => undefined,
    handleChatEvents: async (_req, res) => { called = true; res.writeHead(204); res.end(); },
    handleChatThread: async () => undefined,
    handleChatUpload: async () => undefined,
    handleChatRate: async () => undefined,
    serveChatDemo: (res) => { res.writeHead(204); res.end(); },
  };
  const res = new FakeResponse();
  const handled = await handlePublicHttpFor(deps, req('GET'), res as unknown as ServerResponse, new URL('http://local/chat/pub_demo/events/123e4567-e89b-12d3-a456-426614174000'));

  assert.equal(handled, true);
  assert.equal(called, true);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('public route: widget.js 支持 HEAD，且不会穿透到鉴权闸', async () => {
  const res = new FakeResponse();
  const handled = await handlePublicHttp(req('HEAD'), res as unknown as ServerResponse, new URL('http://local/widget.js'));

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(res.body.length, 0);
});

test('public route: widget.js GET 返回公开组件脚本', async () => {
  const res = new FakeResponse();
  const handled = await handlePublicHttp(req('GET'), res as unknown as ServerResponse, new URL('http://local/widget.js'));

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.ok(res.body.length > 0);
  const body = Buffer.from(res.body).toString('utf8');
  assert.match(body, /cfg\.enabled === false/);
  assert.match(body, /powered_by_visible/);
  assert.match(body, /addEventListener\('delta'/);
  assert.match(body, /createLiveAssistant/);
  assert.match(body, /Last-Event-ID/);
  assert.match(body, /catch \{ host\.remove\(\); return; \}/);
  assert.match(body, /host\.style\.visibility = 'visible'/);
});

test('public route: /uploads/* 公开读取本地媒体且限制在 data/uploads 内', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bailing-public-upload-'));
  try {
    mkdirSync(join(root, 'data', 'uploads', 'bailing', 'chat', 'pub_demo'), { recursive: true });
    writeFileSync(join(root, 'data', 'uploads', 'bailing', 'chat', 'pub_demo', 'a.png'), 'image');
    const deps: PublicHttpDeps = {
      cfg: { root, state: { backend: 'memory' } } as unknown as AppConfig,
      configStore: null,
      queue: { stats: () => ({}) },
      isPaused: () => false,
      serveConsole: (_path, res) => { res.writeHead(204); res.end(); },
      handleChat: async () => undefined,
      handleChatConfig: async () => undefined,
      handleChatEvents: async () => undefined,
      handleChatThread: async () => undefined,
      handleChatUpload: async () => undefined,
      handleChatRate: async () => undefined,
      serveChatDemo: (res) => { res.writeHead(204); res.end(); },
    };
    const res = new FakeResponse();
    const handled = await handlePublicHttpFor(deps, req('GET'), res as unknown as ServerResponse, new URL('http://local/uploads/bailing/chat/pub_demo/a.png'));
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(Buffer.from(res.body).toString('utf8'), 'image');

    const bad = new FakeResponse();
    await handlePublicHttpFor(deps, req('GET'), bad as unknown as ServerResponse, new URL('http://local/uploads/%2e%2e%2fpackage.json'));
    assert.equal(bad.statusCode, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('public route: schema 可从扩展运行时旁边的核心目录回退读取', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bailing-public-schema-'));
  const extensionRoot = join(base, 'custom-runtime');
  const coreSchemaDir = join(base, 'bailinghub', 'schemas', 'config');
  try {
    mkdirSync(extensionRoot, { recursive: true });
    mkdirSync(coreSchemaDir, { recursive: true });
    writeFileSync(join(coreSchemaDir, 'route.schema.json'), '{"title":"Route"}');
    const deps: PublicHttpDeps = {
      cfg: { root: extensionRoot, state: { backend: 'memory' } } as unknown as AppConfig,
      configStore: null,
      queue: { stats: () => ({}) },
      isPaused: () => false,
      serveConsole: (_path, res) => { res.writeHead(204); res.end(); },
      handleChat: async () => undefined,
      handleChatConfig: async () => undefined,
      handleChatEvents: async () => undefined,
      handleChatThread: async () => undefined,
      handleChatUpload: async () => undefined,
      handleChatRate: async () => undefined,
      serveChatDemo: (res) => { res.writeHead(204); res.end(); },
    };
    const res = new FakeResponse();
    const handled = await handlePublicHttpFor(deps, req('GET'), res as unknown as ServerResponse, new URL('http://local/schemas/config/route.schema.json'));
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(Buffer.from(res.body).toString('utf8')), { title: 'Route' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('public route: install.sh 可作为一键安装入口公开读取', async () => {
  const res = new FakeResponse();
  const handled = await handlePublicHttp(req('GET'), res as unknown as ServerResponse, new URL('http://local/install.sh'));

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/x-shellscript; charset=utf-8');
  const body = Buffer.from(res.body).toString('utf8');
  assert.match(body, /BAILING_INSTALL_MODE/);
  assert.match(body, /docker-compose\.images\.yml/);
  assert.match(body, /compose_cmd up \$UP_ARGS/);
});

test('public route: source package 可作为一键安装脚本默认下载源', async () => {
  const res = new FakeResponse();
  const handled = await handlePublicHttp(req('GET'), res as unknown as ServerResponse, new URL('http://local/connect/bailinghub-source.tgz'));

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/gzip');
  assert.ok(res.body.length > 1000);
});

test('public route: OpenClaw stdio 适配器可作为单文件公开下载', async () => {
  const res = new FakeResponse();
  const handled = await handlePublicHttp(req('GET'), res as unknown as ServerResponse, new URL('http://local/connect/openclaw-stdio.mjs'));

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
  const body = Buffer.from(res.body).toString('utf8');
  assert.match(body, /--agent/);
  assert.match(body, /BAILING_SESSION_ID/);
  assert.match(body, /OPENCLAW_FORWARD_BAILING_TOOLS/);
});

test('public route: 执行器接入 Skill 与按需参考文档可公开读取', async () => {
  const skill = new FakeResponse();
  const skillHandled = await handlePublicHttp(req('GET'), skill as unknown as ServerResponse, new URL('http://local/connect/skills/connect-bailinghub-executor/SKILL.md'));
  assert.equal(skillHandled, true);
  assert.equal(skill.statusCode, 200);
  assert.equal(skill.headers['content-type'], 'text/markdown; charset=utf-8');
  const skillBody = Buffer.from(skill.body).toString('utf8');
  assert.match(skillBody, /name: connect-bailinghub-executor/);
  assert.match(skillBody, /BAILING_EXECUTOR_TOKEN/);
  assert.match(skillBody, /references\/direct-protocol\.md/);

  const direct = new FakeResponse();
  await handlePublicHttp(req('GET'), direct as unknown as ServerResponse, new URL('http://local/connect/skills/connect-bailinghub-executor/references/direct-protocol.md'));
  assert.equal(direct.statusCode, 200);
  const directBody = Buffer.from(direct.body).toString('utf8');
  assert.match(directBody, /\/executor\/heartbeat/);
  assert.match(directBody, /claim_token/);

  const openclaw = new FakeResponse();
  await handlePublicHttp(req('HEAD'), openclaw as unknown as ServerResponse, new URL('http://local/connect/skills/connect-bailinghub-executor/references/openclaw.md'));
  assert.equal(openclaw.statusCode, 200);
  assert.equal(openclaw.body.length, 0);
});

test('public route: 根路径进控制台且不托管官网资源', async () => {
  const root = new FakeResponse();
  const rootHandled = await handlePublicHttp(req('GET'), root as unknown as ServerResponse, new URL('http://local/'));
  assert.equal(rootHandled, true);
  assert.equal(root.statusCode, 302);
  assert.equal(root.headers.location, '/console/');

  const docs = new FakeResponse();
  const docsHandled = await handlePublicHttp(req('GET'), docs as unknown as ServerResponse, new URL('http://local/docs/demo'));
  assert.equal(docsHandled, true);
  assert.equal(docs.statusCode, 404);
});
