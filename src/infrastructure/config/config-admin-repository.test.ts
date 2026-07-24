import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminRepository } from './config-admin-repository';

interface StoredAdmin {
  username: string;
  passwordHash: string;
  displayName: string;
  role: string;
}

class FakeAdminDatabase {
  readonly admins: StoredAdmin[] = [];
  private lockTail: Promise<void> = Promise.resolve();

  async acquireLock(): Promise<() => void> {
    const previous = this.lockTail;
    let releaseCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    this.lockTail = previous.then(() => current);
    await previous;
    return releaseCurrent;
  }

  getConnection(): FakeAdminConnection {
    return new FakeAdminConnection(this);
  }
}

class FakeAdminConnection {
  private releaseNamedLock: (() => void) | null = null;
  private pending: StoredAdmin | null = null;

  constructor(private readonly db: FakeAdminDatabase) {}

  async query(sql: string, params: unknown[] = []): Promise<[unknown[], unknown[]]> {
    if (sql.startsWith('SELECT GET_LOCK')) {
      this.releaseNamedLock = await this.db.acquireLock();
      return [[{ acquired: 1 }], []];
    }
    if (sql.startsWith('SELECT 1 AS present')) {
      return [this.db.admins.length ? [{ present: 1 }] : [], []];
    }
    if (sql.startsWith('INSERT INTO bz_admins')) {
      this.pending = {
        username: String(params[0]),
        passwordHash: String(params[1]),
        displayName: String(params[2]),
        role: String(params[3]),
      };
      return [[], []];
    }
    if (sql.startsWith('SELECT RELEASE_LOCK')) {
      this.releaseNamedLock?.();
      this.releaseNamedLock = null;
      return [[{ released: 1 }], []];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  async beginTransaction(): Promise<void> {}

  async commit(): Promise<void> {
    if (this.pending) this.db.admins.push(this.pending);
    this.pending = null;
  }

  async rollback(): Promise<void> {
    this.pending = null;
  }

  release(): void {
    this.releaseNamedLock?.();
    this.releaseNamedLock = null;
  }
}

function repositoryFor(db: FakeAdminDatabase): AdminRepository {
  return new AdminRepository(() => ({
    getConnection: async () => db.getConnection(),
    async query(sql: string) {
      if (sql.startsWith('SELECT 1 AS present')) {
        return [db.admins.length ? [{ present: 1 }] : [], []];
      }
      throw new Error(`unexpected pool SQL: ${sql}`);
    },
  }));
}

test('AdminRepository.hasAny: 管理员表为空和非空时返回稳定布尔值', async () => {
  const db = new FakeAdminDatabase();
  const repository = repositoryFor(db);

  assert.equal(await repository.hasAny(), false);
  db.admins.push({
    username: 'owner',
    passwordHash: 'hash',
    displayName: 'Owner',
    role: 'admin',
  });
  assert.equal(await repository.hasAny(), true);
});

test('AdminRepository.createInitial: 已有任意管理员时不覆盖账号或密码', async () => {
  const db = new FakeAdminDatabase();
  db.admins.push({
    username: 'owner',
    passwordHash: 'original-hash',
    displayName: 'Owner',
    role: 'admin',
  });
  const repository = repositoryFor(db);

  assert.equal(
    await repository.createInitial('replacement', 'replacement-hash', 'Replacement', 'admin'),
    'existing',
  );
  assert.deepEqual(db.admins, [{
    username: 'owner',
    passwordHash: 'original-hash',
    displayName: 'Owner',
    role: 'admin',
  }]);
});

test('AdminRepository.createInitial: 并发冷启动只创建一个管理员', async () => {
  const db = new FakeAdminDatabase();
  const repository = repositoryFor(db);

  const results = await Promise.all([
    repository.createInitial('first', 'hash-one', 'First', 'admin'),
    repository.createInitial('second', 'hash-two', 'Second', 'admin'),
  ]);

  assert.deepEqual(results.sort(), ['created', 'existing']);
  assert.equal(db.admins.length, 1);
  assert.equal(db.admins[0]?.username, 'first');
  assert.equal(db.admins[0]?.passwordHash, 'hash-one');
});

test('AdminRepository.createInitial: 无法取得初始化锁时失败且不写入', async () => {
  let released = false;
  const repository = new AdminRepository(() => ({
    async getConnection() {
      return {
        async query(sql: string) {
          if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: 0 }], []];
          throw new Error(`unexpected SQL: ${sql}`);
        },
        release() { released = true; },
      };
    },
  }));

  await assert.rejects(
    repository.createInitial('admin', 'hash', 'Admin', 'admin'),
    /无法获取首次管理员初始化锁/,
  );
  assert.equal(released, true);
});

test('AdminRepository.upsert: 仅改密时新账号有安全默认角色且已有账号保留原角色', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const repository = new AdminRepository(() => ({
    async query(sql: string, params: unknown[]) {
      capturedSql = sql;
      capturedParams = params;
      return [[], []];
    },
  }));

  await repository.upsert('operator', 'new-hash');

  assert.match(capturedSql, /role=COALESCE\(\?,role\)/);
  assert.equal(capturedParams[3], 'admin');
  assert.equal(capturedParams[6], null);
});

test('AdminRepository.upsert: 显式角色同时用于新建和已有账号更新', async () => {
  let capturedParams: unknown[] = [];
  const repository = new AdminRepository(() => ({
    async query(_sql: string, params: unknown[]) {
      capturedParams = params;
      return [[], []];
    },
  }));

  await repository.upsert('editor', 'new-hash', 'Editor', 'kb_editor');

  assert.equal(capturedParams[3], 'kb_editor');
  assert.equal(capturedParams[6], 'kb_editor');
});
