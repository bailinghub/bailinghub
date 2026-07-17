import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowsUnauthenticatedLocalDevelopment,
  assertServerTokenPolicy,
  isLoopbackHost,
  requireServerToken,
} from './server-token';

test('server token policy: only development loopback may run without a token', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(allowsUnauthenticatedLocalDevelopment('development', 'localhost'), true);
  assert.equal(allowsUnauthenticatedLocalDevelopment('production', 'localhost'), false);

  assert.doesNotThrow(() => assertServerTokenPolicy({ env: 'development', host: '127.0.0.1', token: '' }));
  assert.throws(
    () => assertServerTokenPolicy({ env: 'development', host: '0.0.0.0', token: '' }),
    /BAILING_TOKEN 未配置/,
  );
  assert.throws(
    () => assertServerTokenPolicy({ env: 'production', host: '127.0.0.1', token: '' }),
    /BAILING_TOKEN 未配置/,
  );
});

test('server token policy: exposed deployments reject short and known public values', () => {
  for (const token of ['bailing', 'bailing-dev-admin-token-change-me', 'short-token']) {
    assert.throws(
      () => assertServerTokenPolicy({ env: 'production', host: '0.0.0.0', token }),
      /BAILING_TOKEN 不安全/,
    );
  }

  assert.doesNotThrow(() => assertServerTokenPolicy({
    env: 'production',
    host: '0.0.0.0',
    token: 'c6e591a95a12cb3e912d7270b74f47f4',
  }));
});

test('requireServerToken: signing paths fail closed without a configured secret', () => {
  assert.throws(() => requireServerToken('', '签署测试消息'), /无法签署测试消息/);
  assert.equal(requireServerToken('  strong-secret  ', '签署测试消息'), 'strong-secret');
});
