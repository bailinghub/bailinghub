import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password';

test('password: 使用显式 scrypt profile，哈希可验证且错误密码失败', async () => {
  const stored = await hashPassword('correct horse battery staple');

  assert.match(stored, /^s2\$32768\$8\$3\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('wrong password', stored), false);
  assert.equal(await verifyPassword('correct horse battery staple', 'bad-format'), false);
  assert.equal(await verifyPassword('correct horse battery staple', stored.replace('$32768$', '$16384$')), false);
});
