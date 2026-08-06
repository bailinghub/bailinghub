import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../core/config/config';
import { chatPublicBaseUrl, serveChatDemoFor } from './chat';
import { wecomPublicBaseUrl } from './wecom';

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string | number | string[]> = {};
  body = '';

  writeHead(code: number, headers?: Record<string, string | number | string[]>): void {
    this.statusCode = code;
    if (headers) Object.assign(this.headers, headers);
  }

  end(chunk?: string | Buffer): void {
    this.body = chunk ? chunk.toString() : '';
  }
}

test('chat mount: local media base keeps the trusted tenant prefix', () => {
  const req = {
    headers: {
      host: 'internal.invalid',
      'x-forwarded-host': 'hub.example.com, proxy.invalid',
      'x-forwarded-proto': 'https, http',
    },
  } as unknown as IncomingMessage;

  assert.equal(chatPublicBaseUrl(req), 'https://hub.example.com');
  assert.equal(chatPublicBaseUrl(req, '/tenant/tenant-a'), 'https://hub.example.com/tenant/tenant-a');
  assert.throws(() => chatPublicBaseUrl(req, '/../platform'), /HTTP mount path/);
});

test('channel mount: inbound media base keeps the trusted tenant prefix', () => {
  const req = {
    headers: { host: 'hub.example.com', 'x-forwarded-proto': 'https' },
  } as unknown as IncomingMessage;

  assert.equal(wecomPublicBaseUrl(req, '/tenant/tenant-a'), 'https://hub.example.com/tenant/tenant-a');
});

test('chat mount: demo and copied widget URL keep the tenant prefix', () => {
  const res = new FakeResponse();
  serveChatDemoFor(
    { cfg: { brand: { name: 'Example' } } as AppConfig },
    res as unknown as ServerResponse,
    'pub_demo',
    '/tenant/tenant-a',
  );

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /location\.origin\+"\/tenant\/tenant-a"/);
  assert.match(res.body, /<script src="\/tenant\/tenant-a\/widget\.js"/);
  assert.doesNotMatch(res.body, /<script src="\/widget\.js"/);
});
