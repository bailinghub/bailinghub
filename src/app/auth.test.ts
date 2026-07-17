import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import type { AppConfig } from '../core/config/config';
import { authenticateFor, sessionCookieHeader } from './auth';

function req(headers: Record<string, string>, encrypted = false): IncomingMessage {
  return { headers, socket: { encrypted } } as unknown as IncomingMessage;
}

test('session cookie omits Secure on direct HTTP so demo login works in browsers', () => {
  const cookie = sessionCookieHeader(req({}), 'sid', 60);
  assert.equal(cookie.includes('; Secure'), false);
  assert.equal(cookie, 'bz_sess=sid; Path=/; HttpOnly; SameSite=Lax; Max-Age=60');
});

test('session cookie keeps Secure behind HTTPS and HTTPS reverse proxies', () => {
  assert.equal(sessionCookieHeader(req({}, true), 'sid', 60).includes('; Secure'), true);
  assert.equal(sessionCookieHeader(req({ 'x-forwarded-proto': 'https' }), 'sid', 60).includes('; Secure'), true);
});

function authConfig(env: 'development' | 'production', host: string, token = ''): AppConfig {
  return { env, server: { host, port: 18900, token } } as AppConfig;
}

test('authenticateFor: tokenless admin fallback is restricted to local development', async () => {
  const local = await authenticateFor(
    { cfg: authConfig('development', '127.0.0.1'), configStore: null },
    req({}),
    new URL('http://127.0.0.1:18900/admin/api/me'),
  );
  assert.deepEqual(local, { kind: 'admin', via: 'token', username: 'dev' });

  const exposed = await authenticateFor(
    { cfg: authConfig('development', '0.0.0.0'), configStore: null },
    req({}),
    new URL('http://example.test/admin/api/me'),
  );
  assert.equal(exposed, null);

  const production = await authenticateFor(
    { cfg: authConfig('production', '127.0.0.1'), configStore: null },
    req({}),
    new URL('http://127.0.0.1:18900/admin/api/me'),
  );
  assert.equal(production, null);
});
