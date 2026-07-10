import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { sessionCookieHeader } from './auth';

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
