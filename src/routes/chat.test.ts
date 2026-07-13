import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../core/config/config';
import type { ChatEntry } from '../core/contracts/types';
import type { RuntimeContext } from '../core/edition';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { handleChatConfigFor, type ChatApiDeps } from './chat';

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

function request(origin = 'https://shop.example.com'): IncomingMessage {
  return { headers: { origin } } as IncomingMessage;
}

function entry(overrides: Partial<ChatEntry> = {}): ChatEntry {
  return {
    entry_key: 'pub_demo1234',
    name: '官网助手',
    route_key: 'chat.main',
    enabled: true,
    allowed_origins: ['https://shop.example.com'],
    rate_limit_per_min: 20,
    ...overrides,
  };
}

function deps(value: ChatEntry | null): ChatApiDeps {
  const config = {
    chatEntries: { get: async () => value },
  } as unknown as ConfigStoreContract;
  return {
    cfg: { brand: { name: '百灵中枢' } } as AppConfig,
    isPaused: () => false,
    runtimeContextFor: async () => ({} as RuntimeContext),
    runtimeStoresFor: () => ({ state: {} as RuntimeStateStore, config }),
    resolveProjectPathFor: async () => null,
    now: () => new Date(0).toISOString(),
    engineForContext: () => ({ launchJob: async () => { throw new Error('not used'); } }),
  };
}

async function configBody(value: ChatEntry | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = new FakeResponse();
  await handleChatConfigFor(deps(value), request(), res as unknown as ServerResponse, 'pub_demo1234');
  return {
    status: res.statusCode,
    body: JSON.parse(Buffer.from(res.body).toString('utf8')) as Record<string, unknown>,
  };
}

test('chat config: 启用入口下发品牌控制且保留部署品牌兼容字段', async () => {
  const result = await configBody(entry({
    appearance: { powered_by_visible: true, powered_by_text: '由示例业务驱动' },
  }));

  assert.equal(result.status, 200);
  assert.equal(result.body.enabled, true);
  assert.equal(result.body.brand, '百灵中枢');
  assert.equal(result.body.powered_by_visible, true);
  assert.equal(result.body.powered_by_text, '由示例业务驱动');
});

test('chat config: 老入口生成默认品牌文案', async () => {
  const result = await configBody(entry());

  assert.equal(result.status, 200);
  assert.equal(result.body.powered_by_visible, true);
  assert.equal(result.body.powered_by_text, '由 百灵中枢 驱动');
});

test('chat config: 停用入口返回静默隐藏状态，不存在入口仍返回 404', async () => {
  const disabled = await configBody(entry({ enabled: false }));
  assert.equal(disabled.status, 200);
  assert.deepEqual(disabled.body, { enabled: false });

  const missing = await configBody(null);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: '聊天入口不存在' });
});
