import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMetricsTokenPolicy } from './metrics-token';

test('metrics token: disabled endpoint does not require a token', () => {
  assert.doesNotThrow(() => assertMetricsTokenPolicy({ enabled: false, token: '', serverToken: '' }));
});

test('metrics token: enabled endpoint rejects missing, weak and reused secrets', () => {
  assert.throws(
    () => assertMetricsTokenPolicy({ enabled: true, token: '', serverToken: '' }),
    /BAILING_METRICS_TOKEN 不安全/,
  );
  assert.throws(
    () => assertMetricsTokenPolicy({ enabled: true, token: 'replace-with-a-long-random-secret', serverToken: '' }),
    /BAILING_METRICS_TOKEN 不安全/,
  );
  const token = 'metrics-token-with-enough-entropy-2026';
  assert.throws(
    () => assertMetricsTokenPolicy({ enabled: true, token, serverToken: token }),
    /必须与 BAILING_TOKEN 分离/,
  );
});

test('metrics token: dedicated strong secret is accepted', () => {
  assert.doesNotThrow(() => assertMetricsTokenPolicy({
    enabled: true,
    token: 'metrics-only-token-with-enough-entropy-2026',
    serverToken: 'server-only-token-with-enough-entropy-2026',
  }));
});
