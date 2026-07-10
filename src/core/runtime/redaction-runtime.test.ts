import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactValue, redactionSummary } from './redaction-runtime';

test('redactText: 默认脱敏常见个人信息和 token-like 字符串', () => {
  const got = redactText('用户 13800138000 邮箱 a@test.com 身份证 11010119900307777X Bearer abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnopqrstuvwxyz');
  assert.equal(got.includes('13800138000'), false);
  assert.equal(got.includes('a@test.com'), false);
  assert.equal(got.includes('11010119900307777X'), false);
  assert.equal(got.includes('Bearer abcdefghijklmnopqrstuvwxyz'), false);
  assert.ok(got.includes('[REDACTED_PHONE]'));
  assert.ok(got.includes('[REDACTED_EMAIL]'));
  assert.ok(got.includes('[REDACTED_ID]'));
  assert.ok(got.includes('Bearer [REDACTED_TOKEN]'));
});

test('redactValue: 递归脱敏对象并按敏感 key 直接遮蔽', () => {
  const got = redactValue({
    text: '联系 13900139000',
    nested: { api_key: 'sk-live-secret', profile: { email: 'ops@example.com' } },
    arr: [{ token: 'tk-secret-value' }, 'user@example.com'],
  });
  assert.deepEqual(got, {
    text: '联系 [REDACTED_PHONE]',
    nested: { api_key: '[REDACTED_SECRET]', profile: { email: '[REDACTED_EMAIL]' } },
    arr: [{ token: '[REDACTED_SECRET]' }, '[REDACTED_EMAIL]'],
  });
});

test('redactionSummary: 输出稳定规则清单', () => {
  const s = redactionSummary();
  assert.equal(s.applied, true);
  assert.ok(s.rules.includes('phone_cn'));
  assert.ok(s.rules.includes('email'));
});
