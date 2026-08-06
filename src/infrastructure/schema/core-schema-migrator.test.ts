import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { MysqlConfig } from '../../core/config/config';
import {
  migrateBailingHubCoreSchema,
  type CoreSchemaMigrationConnectionV1,
} from './core-schema-migrator';
import { BAILINGHUB_RETIRED_CORE_MIGRATIONS_V1 } from './retired-migrations';

const CORE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SQL_DIRECTORY = join(CORE_ROOT, 'sql');
const MYSQL_CONFIG: MysqlConfig = {
  host: 'mysql.internal',
  port: 3306,
  database: 'bailinghub_test',
  user: 'test',
  password: 'not-used',
  connectionLimit: 1,
};

interface OfficialMigration {
  filename: string;
  checksum: string;
}

function officialMigrations(): OfficialMigration[] {
  return readdirSync(SQL_DIRECTORY)
    .filter((filename) => filename.endsWith('.sql'))
    .sort()
    .map((filename) => ({
      filename,
      checksum: createHash('sha256')
        .update(readFileSync(join(SQL_DIRECTORY, filename), 'utf8'), 'utf8')
        .digest('hex'),
    }));
}

class FakeMigrationConnection implements CoreSchemaMigrationConnectionV1 {
  readonly ledger = new Map<string, string | null>();
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  readonly migrationStatements: string[] = [];
  statementErrnos: number[] = [];
  statementFaults: Array<{ pattern: RegExp; errno: number }> = [];
  fullColumns = new Map<string, Array<Record<string, unknown>>>();
  indexes = new Map<string, Array<Record<string, unknown>>>();
  lockResult = 1;
  releaseResult = 1;
  releases = 0;
  ends = 0;

  async query(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    this.queries.push({ sql, params });

    if (sql.startsWith('SELECT GET_LOCK')) {
      return [[{ acquired: this.lockResult }], []];
    }
    if (sql.startsWith('SELECT RELEASE_LOCK')) {
      this.releases++;
      return [[{ released: this.releaseResult }], []];
    }
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS `bz_schema_migrations`')) {
      return [{ affectedRows: 0 }, []];
    }
    if (sql.startsWith('ALTER TABLE `bz_schema_migrations`')) {
      throw mysqlError(1060, 'Duplicate column name checksum_sha256');
    }
    if (sql === 'SELECT `filename`, `checksum_sha256` FROM `bz_schema_migrations`') {
      return [[...this.ledger].map(([filename, checksum_sha256]) => ({
        filename,
        checksum_sha256,
      })), []];
    }
    if (sql.startsWith('UPDATE `bz_schema_migrations` SET `checksum_sha256`=')) {
      const checksum = String(params[0]);
      const filename = String(params[1]);
      if (this.ledger.get(filename) === null) {
        this.ledger.set(filename, checksum);
        return [{ affectedRows: 1 }, []];
      }
      return [{ affectedRows: 0 }, []];
    }
    if (sql.startsWith('SELECT `checksum_sha256` FROM `bz_schema_migrations`')) {
      const filename = String(params[0]);
      if (!this.ledger.has(filename)) return [[], []];
      return [[{ checksum_sha256: this.ledger.get(filename) }], []];
    }
    if (sql.startsWith('INSERT INTO `bz_schema_migrations`')) {
      this.ledger.set(String(params[0]), String(params[1]));
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('SHOW FULL COLUMNS FROM')) {
      const table = /FROM `([^`]+)`/.exec(sql)?.[1] ?? '';
      return [this.fullColumns.get(table) ?? [], []];
    }
    if (sql.startsWith('SHOW INDEX FROM')) {
      const table = /FROM `([^`]+)`/.exec(sql)?.[1] ?? '';
      return [this.indexes.get(`${table}:${String(params[0] ?? '')}`) ?? [], []];
    }

    this.migrationStatements.push(sql);
    const faultIndex = this.statementFaults.findIndex((fault) => fault.pattern.test(sql));
    if (faultIndex >= 0) {
      const fault = this.statementFaults.splice(faultIndex, 1)[0]!;
      throw mysqlError(fault.errno, `simulated mysql errno ${fault.errno}`);
    }
    const errno = this.statementErrnos.shift();
    if (errno !== undefined) throw mysqlError(errno, `simulated mysql errno ${errno}`);
    return [{ affectedRows: 0 }, []];
  }

  async end(): Promise<void> {
    this.ends++;
  }
}

function mysqlError(errno: number, message: string): Error & { errno: number } {
  return Object.assign(new Error(message), { errno });
}

function seedLedgerWithCurrentChecksums(connection: FakeMigrationConnection): void {
  for (const migration of officialMigrations()) {
    connection.ledger.set(migration.filename, migration.checksum);
  }
}

test('Core Schema Migrator: 只按官方 SQL 顺序执行并且重复运行幂等', async () => {
  const connection = new FakeMigrationConnection();
  const official = officialMigrations();

  const first = await migrateBailingHubCoreSchema({
    mysql: MYSQL_CONFIG,
    connection,
  });

  assert.deepEqual(first.appliedFiles, official.map((migration) => migration.filename));
  assert.equal(first.skippedFiles.length, 0);
  assert.equal(first.toleratedStatements, 0);
  assert.equal(connection.ledger.size, official.length);
  assert.equal(connection.ledger.get(official[0]!.filename), official[0]!.checksum);
  for (const retired of BAILINGHUB_RETIRED_CORE_MIGRATIONS_V1) {
    assert.equal(connection.ledger.has(retired.filename), false, `${retired.filename} must not be replayed`);
  }
  assert.equal(connection.queries[0]?.sql.startsWith('SELECT GET_LOCK'), true);
  assert.equal(connection.releases, 1);
  assert.equal(connection.ends, 0, '注入连接的生命周期应由调用方负责');

  const statementCountAfterFirstRun = connection.migrationStatements.length;
  const second = await migrateBailingHubCoreSchema({
    mysql: { ...MYSQL_CONFIG, host: 'same-db-through-another-alias.internal' },
    connection,
  });

  assert.equal(second.lockName, first.lockName, '同一数据库经不同主机别名连接时必须竞争同一把锁');
  assert.equal(second.appliedFiles.length, 0);
  assert.deepEqual(second.skippedFiles, official.map((migration) => migration.filename));
  assert.equal(connection.migrationStatements.length, statementCountAfterFirstRun);
  assert.equal(connection.releases, 2);
});

test('Core Schema Migrator: 只有列和索引结构与官方语句一致时才容忍重复对象', async () => {
  const connection = new FakeMigrationConnection();
  seedLedgerWithCurrentChecksums(connection);
  connection.ledger.delete('003_executor.sql');
  connection.statementFaults = [
    { pattern: /ADD COLUMN `input`/, errno: 1060 },
    { pattern: /ADD KEY `idx_claim`/, errno: 1061 },
  ];
  connection.fullColumns.set('bz_jobs', [
    { Field: 'input', Type: 'mediumtext', Null: 'YES', Default: null },
  ]);
  connection.indexes.set('bz_jobs:idx_claim', [
    { Seq_in_index: 1, Column_name: 'status', Non_unique: 1 },
    { Seq_in_index: 2, Column_name: 'target', Non_unique: 1 },
    { Seq_in_index: 3, Column_name: 'created_at', Non_unique: 1 },
  ]);

  const result = await migrateBailingHubCoreSchema({ mysql: MYSQL_CONFIG, connection });
  assert.deepEqual(result.appliedFiles, ['003_executor.sql']);
  assert.equal(result.toleratedStatements, 2);
});

test('Core Schema Migrator: 同名列结构冲突时不容忍、不记账', async () => {
  const connection = new FakeMigrationConnection();
  seedLedgerWithCurrentChecksums(connection);
  connection.ledger.delete('003_executor.sql');
  connection.statementFaults = [{ pattern: /ADD COLUMN `input`/, errno: 1060 }];
  connection.fullColumns.set('bz_jobs', [
    { Field: 'input', Type: 'varchar(32)', Null: 'YES', Default: null },
  ]);

  await assert.rejects(
    migrateBailingHubCoreSchema({ mysql: MYSQL_CONFIG, connection }),
    /003_executor\.sql 执行失败/,
  );
  assert.equal(connection.ledger.has('003_executor.sql'), false);
});

test('Core Schema Migrator: 兼容文件名旧账本，补录摘要但绝不重放已记账 SQL', async () => {
  const connection = new FakeMigrationConnection();
  const official = officialMigrations();
  for (const migration of official) connection.ledger.set(migration.filename, null);

  const first = await migrateBailingHubCoreSchema({
    mysql: MYSQL_CONFIG,
    connection,
  });

  assert.deepEqual(first.checksumBackfilledFiles, official.map((migration) => migration.filename));
  assert.deepEqual(first.skippedFiles, official.map((migration) => migration.filename));
  assert.equal(first.appliedFiles.length, 0);
  assert.equal(connection.migrationStatements.length, 0);
  for (const migration of official) {
    assert.equal(connection.ledger.get(migration.filename), migration.checksum);
  }

  const second = await migrateBailingHubCoreSchema({
    mysql: MYSQL_CONFIG,
    connection,
  });
  assert.equal(second.checksumBackfilledFiles.length, 0);
  assert.equal(second.appliedFiles.length, 0);
  assert.equal(connection.migrationStatements.length, 0);
});

test('Core Schema Migrator: 生产旧账本补录活动与退役摘要，退役 SQL 绝不重放', async () => {
  const connection = new FakeMigrationConnection();
  const official = officialMigrations();
  for (const migration of official) connection.ledger.set(migration.filename, null);
  for (const migration of BAILINGHUB_RETIRED_CORE_MIGRATIONS_V1) {
    connection.ledger.set(migration.filename, null);
  }

  const first = await migrateBailingHubCoreSchema({ mysql: MYSQL_CONFIG, connection });
  const expectedBackfills = [
    ...official.map((migration) => migration.filename),
    ...BAILINGHUB_RETIRED_CORE_MIGRATIONS_V1.map((migration) => migration.filename),
  ].sort();

  assert.deepEqual(first.checksumBackfilledFiles, expectedBackfills);
  assert.deepEqual(first.skippedFiles, official.map((migration) => migration.filename));
  assert.equal(first.appliedFiles.length, 0);
  assert.equal(connection.migrationStatements.length, 0);
  for (const retired of BAILINGHUB_RETIRED_CORE_MIGRATIONS_V1) {
    assert.equal(connection.ledger.get(retired.filename), retired.checksumSha256);
    assert.equal(first.skippedFiles.includes(retired.filename), false);
  }

  const second = await migrateBailingHubCoreSchema({ mysql: MYSQL_CONFIG, connection });
  assert.equal(second.checksumBackfilledFiles.length, 0);
  assert.deepEqual(second.skippedFiles, official.map((migration) => migration.filename));
  assert.equal(connection.migrationStatements.length, 0);
});

test('Core Schema Migrator: 已发布 SQL 摘要漂移时在执行新迁移前失败并释放锁', async () => {
  const connection = new FakeMigrationConnection();
  seedLedgerWithCurrentChecksums(connection);
  const first = officialMigrations()[0]!;
  connection.ledger.set(first.filename, '0'.repeat(64));

  await assert.rejects(
    migrateBailingHubCoreSchema({ mysql: MYSQL_CONFIG, connection }),
    new RegExp(`${first.filename}.*账本摘要不一致`),
  );

  assert.equal(connection.migrationStatements.length, 0);
  assert.equal(connection.releases, 1);
});

test('Core Schema Migrator: 退役迁移摘要不匹配时失败关闭且不写账本', async () => {
  const connection = new FakeMigrationConnection();
  seedLedgerWithCurrentChecksums(connection);
  const retired = BAILINGHUB_RETIRED_CORE_MIGRATIONS_V1[0]!;
  connection.ledger.set(retired.filename, '0'.repeat(64));

  await assert.rejects(
    migrateBailingHubCoreSchema({ mysql: MYSQL_CONFIG, connection }),
    new RegExp(`${retired.filename}.*账本摘要不一致`),
  );

  assert.equal(connection.queries.some(({ sql }) => sql.startsWith('UPDATE `bz_schema_migrations`')), false);
  assert.equal(connection.migrationStatements.length, 0);
  assert.equal(connection.releases, 1);
});

test('Core Schema Migrator: 账本含当前 artifact 未知迁移时拒绝降级且不写摘要', async () => {
  const connection = new FakeMigrationConnection();
  seedLedgerWithCurrentChecksums(connection);
  connection.ledger.set('999_from_newer_core.sql', null);

  await assert.rejects(
    migrateBailingHubCoreSchema({ mysql: MYSQL_CONFIG, connection }),
    /当前 artifact 不认识的迁移：999_from_newer_core\.sql/,
  );

  assert.equal(connection.queries.some(({ sql }) => sql.startsWith('UPDATE `bz_schema_migrations`')), false);
  assert.equal(connection.migrationStatements.length, 0);
  assert.equal(connection.releases, 1);
});

test('Core Schema Migrator: 普通 SQL 错误不吞掉、不记账，并始终释放锁', async () => {
  const connection = new FakeMigrationConnection();
  connection.statementErrnos = [1146];
  const first = officialMigrations()[0]!;

  await assert.rejects(
    migrateBailingHubCoreSchema({ mysql: MYSQL_CONFIG, connection }),
    new RegExp(`${first.filename} 执行失败`),
  );

  assert.equal(connection.ledger.has(first.filename), false);
  assert.equal(connection.releases, 1);
});

test('Core Schema Migrator: 无法取得数据库级锁时不触碰账本，工厂连接由迁移器关闭', async () => {
  const connection = new FakeMigrationConnection();
  connection.lockResult = 0;
  let factoryCalls = 0;

  await assert.rejects(
    migrateBailingHubCoreSchema({
      mysql: MYSQL_CONFIG,
      lockTimeoutSeconds: 7,
      connectionFactory: async () => {
        factoryCalls++;
        return connection;
      },
    }),
    /无法在 7 秒内取得 Core Schema 迁移锁/,
  );

  assert.equal(factoryCalls, 1);
  assert.equal(connection.queries.length, 1);
  assert.equal(connection.queries[0]?.params[1], 7);
  assert.equal(connection.releases, 0);
  assert.equal(connection.ends, 1);
});
