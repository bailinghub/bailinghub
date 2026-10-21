import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBailingHubKernel } from './kernel';
import { createPool, type RowDataPacket } from 'mysql2/promise';
import type { AppConfig } from '../core/config/config';
import { BAILINGHUB_CORE_ARTIFACT_V1 as artifact } from '../kernel-api/v1/artifact';
import { migrateBailingHubCoreSchema } from '../infrastructure/schema/core-schema-migrator';
import { ConfigStore } from '../infrastructure/config/configstore';
import { MysqlStore } from '../infrastructure/state/state-mysql';
import { checkReadinessFor } from './readiness';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';

test('readiness validates both real MySQL resources without mutating legacy or corrupt ledgers', { skip: !enabled, timeout: 120_000 }, async t => {
  const prefix = `ready_${randomBytes(8).toString('hex')}`;
  const names = [`${prefix}_state`, `${prefix}_config`];
  const base = { host: '127.0.0.1', port: Number(process.env.BAILING_USAGE_TEST_MYSQL_PORT ?? 16307), user: 'root', password: '', connectionLimit: 2 };
  const admin = createPool(base); const pools = names.map(database => createPool({ ...base, database }));
  const created: string[] = [];
  const state = new MysqlStore({ ...base, database: names[0]! }, { get: async () => pools[0]!, close: async () => {} });
  const config = new ConfigStore({ ...base, database: names[1]! }, { get: async () => pools[1]!, close: async () => {} });
  const sharedConfig = new ConfigStore({ ...base, database: names[0]! }, { get: async () => pools[0]!, close: async () => {} });
  const cfg = { root: '/not-a-migration-directory', state: { backend: 'mysql', mysql: { ...base, database: names[0] } } } as AppConfig;
  const latest = artifact.migrations.at(-1)!;
  const ledger = async (index: number) => (await pools[index]!.query<RowDataPacket[]>('SELECT filename,checksum_sha256,applied_at FROM bz_schema_migrations ORDER BY filename'))[0];
  try {
    for (const name of names) {
      assert.match(name, new RegExp(`^${prefix}_(state|config)$`));
      await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`); created.push(name);
      await migrateBailingHubCoreSchema({ mysql: { ...base, database: name }, logger: { log() {}, warn() {} } });
    }
    await state.init(); await config.init(); await sharedConfig.init();
    await t.test('complete shared and split databases are ready', async () => {
      assert.equal((await checkReadinessFor(cfg, config, state)).ready, true);
      assert.equal((await checkReadinessFor(cfg, sharedConfig, state)).ready, true);
    });
    for (const [index, role] of ['state', 'configuration'].entries()) {
      await t.test(`missing latest migration on ${role} returns not-ready`, async () => {
        const before = await ledger(index); const row = before.find(item => item.filename === latest.filename)!;
        await pools[index]!.query('DELETE FROM bz_schema_migrations WHERE filename=?', [latest.filename]);
        const report = await checkReadinessFor(cfg, config, state);
        assert.equal(report.ready, false); assert.deepEqual(report.checks.migrations, { status: 'pending', pending: 1 });
        assert.equal((await ledger(index)).length, before.length - 1, 'readiness must not apply a migration');
        await pools[index]!.query('INSERT INTO bz_schema_migrations(filename,checksum_sha256,applied_at) VALUES (?,?,?)', [row.filename, row.checksum_sha256, row.applied_at]);
        assert.deepEqual(await ledger(index), before);
      });
      for (const checksum of [null, '0'.repeat(64)]) {
        await t.test(`${role} ${checksum === null ? 'NULL' : 'conflicting'} checksum fails without backfill`, async () => {
          await pools[index]!.query('UPDATE bz_schema_migrations SET checksum_sha256=? WHERE filename=?', [checksum, latest.filename]);
          const before = await ledger(index); const report = await checkReadinessFor(cfg, config, state);
          assert.equal(report.ready, false); assert.equal(report.checks.migrations.status, 'failed');
          assert.deepEqual(await ledger(index), before, 'readiness cannot repair the ledger');
          await pools[index]!.query('UPDATE bz_schema_migrations SET checksum_sha256=? WHERE filename=?', [latest.checksumSha256, latest.filename]);
        });
      }
      await t.test(`${role} unknown future record fails without dropping it`, async () => {
        await pools[index]!.query('INSERT INTO bz_schema_migrations(filename,checksum_sha256) VALUES (?,?)', ['999_synthetic_future.sql', '0'.repeat(64)]);
        const before = await ledger(index); const report = await checkReadinessFor(cfg, config, state);
        assert.equal(report.ready, false); assert.equal(report.checks.migrations.status, 'failed'); assert.deepEqual(await ledger(index), before);
        await pools[index]!.query('DELETE FROM bz_schema_migrations WHERE filename=?', ['999_synthetic_future.sql']);
      });
    }
    await t.test('JSONL state still checks configuration; missing checksum column requires explicit migrator', async () => {
      const jsonl = { ...cfg, state: { ...cfg.state, backend: 'jsonl' as const } };
      assert.equal((await checkReadinessFor(jsonl, config)).ready, true);
      await pools[1]!.query('ALTER TABLE bz_schema_migrations DROP COLUMN checksum_sha256');
      assert.equal((await checkReadinessFor(jsonl, config)).ready, false);
      const [columns] = await pools[1]!.query<RowDataPacket[]>('SHOW COLUMNS FROM bz_schema_migrations');
      assert.equal(columns.some(row => row.Field === 'checksum_sha256'), false, 'probe must not add the checksum column');
      const repaired = await migrateBailingHubCoreSchema({ mysql: { ...base, database: names[1]! }, logger: { log() {}, warn() {} } });
      assert.equal(repaired.checksumBackfilledFiles.length, artifact.migrations.length); assert.deepEqual(repaired.appliedFiles, []);
      assert.equal((await checkReadinessFor(jsonl, config)).ready, true);
    });
    await t.test('Kernel.readiness and real /health/ready expose the same ledger decision', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'readiness-kernel-'));
      const runtime: AppConfig = { root: process.cwd(), runtimeRoot: dir, env: 'development',
        server: { host: '127.0.0.1', port: 0, token: '' }, brand: { name: 'Synthetic readiness test' },
        displayTz: 'Asia/Shanghai', displayTzLabel: '北京时间', auditRetentionDays: 0, alerts: null,
        metrics: { enabled: false, token: '', scrapeTimeoutMs: 1000 }, bootstrapAdmin: null,
        concurrency: 1, killSwitchFile: join(dir, '.paused'), claudeBin: 'synthetic-unused', defaultProfile: 'readonly', brainDir: join(dir, 'brain'),
        state: { backend: 'mysql', jsonlPath: join(dir, 'jobs.jsonl'), mysql: { ...base, database: names[0]! } }, projects: {}, llmCredentials: {},
        executor: { hubUrl: '', token: '', executorId: 'synthetic', targets: [], waitMs: 100, concurrency: 1, labels: [] } };
      const kernel = createBailingHubKernel({ instanceKey: prefix, config: runtime, schedulerMode: 'managed', bootstrapLocalAdmin: false,
        logger: { log() {}, warn() {}, error() {} } });
      const server = createServer((req, res) => { void kernel.handle(req, res, new URL(req.url ?? '/', 'http://local')).catch(() => { res.statusCode = 500; res.end(); }); });
      try {
        await kernel.initialize();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        const url = `http://127.0.0.1:${address.port}/health/ready`;
        assert.equal((await kernel.readiness()).ready, true); assert.equal((await fetch(url)).status, 200);
        await pools[0]!.query('UPDATE bz_schema_migrations SET checksum_sha256=NULL WHERE filename=?', [latest.filename]);
        assert.equal((await kernel.readiness()).ready, false);
        const failed = await fetch(url); assert.equal(failed.status, 503);
        const body = await failed.json() as { status: string; checks: { migrations: { status: string } } };
        assert.equal(body.status, 'not_ready'); assert.equal(body.checks.migrations.status, 'failed');
        assert.doesNotMatch(JSON.stringify(body), /password|127\.0\.0\.1|checksum_sha256/);
        await pools[0]!.query('UPDATE bz_schema_migrations SET checksum_sha256=? WHERE filename=?', [latest.checksumSha256, latest.filename]);
        assert.equal((await kernel.readiness()).ready, true); assert.equal((await fetch(url)).status, 200);
      } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        await kernel.close(); rmSync(dir, { recursive: true, force: true });
      }
    });
    await t.test('both existing pools remain usable after repeated readiness calls', async () => {
      for (let i = 0; i < 3; i++) assert.equal((await checkReadinessFor(cfg, config, state)).ready, true);
      for (const pool of pools) await pool.query('SELECT 1');
    });
  } finally {
    for (const pool of pools) await pool.end();
    for (const name of created) { assert.match(name, new RegExp(`^${prefix}_(state|config)$`)); await admin.query(`DROP DATABASE \`${name}\``); }
    const [left] = await admin.query<RowDataPacket[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE ?', [`${prefix}_%`]);
    assert.equal(left.length, 0); t.diagnostic(`cleaned ${created.length} random schemas; no leftovers`); await admin.end();
  }
});
