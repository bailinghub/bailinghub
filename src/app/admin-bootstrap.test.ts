import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapInitialAdmin, type InitialAdminRepository } from './admin-bootstrap';

test('bootstrapInitialAdmin: 未配置时不访问仓储', async () => {
  let called = false;
  const admins: InitialAdminRepository = {
    async hasAny() {
      called = true;
      return false;
    },
    async createInitial() {
      called = true;
      return 'created';
    },
  };

  assert.equal(await bootstrapInitialAdmin(null, { admins }), 'disabled');
  assert.equal(called, false);
});

test('bootstrapInitialAdmin: 首次创建只传递哈希并且日志不含密码', async () => {
  const secret = 'never-log-this-password';
  const logs: string[] = [];
  const calls: unknown[][] = [];
  const admins: InitialAdminRepository = {
    async hasAny() { return false; },
    async createInitial(...args) {
      calls.push(args);
      return 'created';
    },
  };

  const result = await bootstrapInitialAdmin(
    { username: 'owner', password: secret },
    {
      admins,
      async hash(password) {
        assert.equal(password, secret);
        return 'hashed-password';
      },
      logger: { log(message) { logs.push(String(message)); } },
    },
  );

  assert.equal(result, 'created');
  assert.deepEqual(calls, [['owner', 'hashed-password', 'owner', 'admin']]);
  assert.match(logs.join('\n'), /owner/);
  assert.doesNotMatch(logs.join('\n'), new RegExp(secret));
});

test('bootstrapInitialAdmin: 已有管理员时只报告跳过且不泄漏密码', async () => {
  const secret = 'existing-admin-secret';
  const logs: string[] = [];
  let hashed = false;
  let created = false;
  const admins: InitialAdminRepository = {
    async hasAny() { return true; },
    async createInitial() {
      created = true;
      return 'existing';
    },
  };

  const result = await bootstrapInitialAdmin(
    { username: 'ignored', password: secret },
    {
      admins,
      async hash() {
        hashed = true;
        return 'must-not-be-computed';
      },
      logger: { log(message) { logs.push(String(message)); } },
    },
  );

  assert.equal(result, 'existing');
  assert.equal(hashed, false);
  assert.equal(created, false);
  assert.match(logs.join('\n'), /跳过/);
  assert.doesNotMatch(logs.join('\n'), new RegExp(secret));
});

test('bootstrapInitialAdmin: 预检查后出现并发管理员时仍不覆盖', async () => {
  const admins: InitialAdminRepository = {
    async hasAny() { return false; },
    async createInitial() { return 'existing'; },
  };
  const logs: string[] = [];

  const result = await bootstrapInitialAdmin(
    { username: 'admin', password: 'long-enough-password' },
    {
      admins,
      async hash() { return 'hashed-password'; },
      logger: { log(message) { logs.push(String(message)); } },
    },
  );

  assert.equal(result, 'existing');
  assert.match(logs.join('\n'), /跳过/);
});

test('bootstrapInitialAdmin: 配置存在但无配置存储时拒绝启动', async () => {
  await assert.rejects(
    bootstrapInitialAdmin(
      { username: 'admin', password: 'long-enough-password' },
      { admins: null },
    ),
    /需要可用的配置存储/,
  );
});
