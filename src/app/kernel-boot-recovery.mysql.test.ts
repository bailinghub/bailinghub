import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createPool, type Pool } from 'mysql2/promise';
import type { AppConfig } from '../core/config/config';
import { MysqlPoolOwner } from '../infrastructure/mysql/pool-owner';
import { migrateBailingHubCoreSchema } from '../infrastructure/schema/core-schema-migrator';
import { MysqlStore } from '../infrastructure/state/state-mysql';
import { createBailingHubKernel } from './kernel';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';

// A fresh schema runs the complete migration history before the 2s boot timer.
// Leave setup headroom on shared CI hosts; the actual lock observation below
// still has its own short deadline, so a recovery regression cannot hide here.
test('standalone boot recovery retains its MySQL pool while an actual requeue UPDATE waits on a row lock', { skip: !enabled, timeout: 120_000 }, async t => {
  const startedAt = performance.now();
  const database = `boot_recovery_${randomUUID().replaceAll('-', '')}`;
  const dir = await mkdtemp(join(tmpdir(), 'kernel-boot-mysql-'));
  const mysql = { host: '127.0.0.1', port: Number(process.env.BAILING_USAGE_TEST_MYSQL_PORT ?? 16307),
    user: 'root', password: '', database, connectionLimit: 4 };
  // Explicitly loopback-only, random disposable schema; no deployment config.
  const admin = createPool({ ...mysql, database: undefined });
  let kernel: ReturnType<typeof createBailingHubKernel> | undefined;
  let server: ReturnType<ReturnType<typeof createBailingHubKernel>['createStandaloneServer']> | undefined;
  let lockConnection: Awaited<ReturnType<typeof admin.getConnection>> | undefined;
  let created = false;
  let failure: unknown;
  const releaseTestLockOnAbort = () => {
    // This is the fixture's external blocker, never the runtime's SQL pool.
    // Destroying this connection rolls back its transaction even after timeout.
    lockConnection?.destroy();
    lockConnection = undefined;
  };
  t.signal.addEventListener('abort', releaseTestLockOnAbort, { once: true });
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    created = true;
    await migrateBailingHubCoreSchema({ mysql, logger: { log() {}, warn() {} } });
    t.signal.throwIfAborted();
    t.diagnostic(`isolated schema migration completed in ${Math.round(performance.now() - startedAt)}ms`);
    const seed = new MysqlStore(mysql);
    await seed.init();
    try {
      await seed.createJob({ job_id: 'synthetic-orphan', request_id: 'synthetic-recovery', status: 'running',
        target: 'synthetic-uninstalled', source: 'test', profile: 'readonly', project: '', input_preview: '', metadata: {},
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    } finally { await seed.close(); }
    t.signal.throwIfAborted();
    lockConnection = await admin.getConnection();
    await lockConnection.beginTransaction();
    await lockConnection.query(`SELECT job_id FROM \`${database}\`.bz_jobs WHERE job_id=? FOR UPDATE`, ['synthetic-orphan']);

    const config: AppConfig = { root: process.cwd(), runtimeRoot: dir, env: 'development',
      server: { host: '127.0.0.1', port: 0, token: '' }, brand: { name: 'Synthetic SQL recovery test' },
      displayTz: 'Asia/Shanghai', displayTzLabel: '北京时间', auditRetentionDays: 0, alerts: null,
      metrics: { enabled: false, token: '', scrapeTimeoutMs: 1000 }, bootstrapAdmin: null,
      concurrency: 1, killSwitchFile: join(dir, '.paused'), claudeBin: 'synthetic-unused', defaultProfile: 'readonly', brainDir: join(dir, 'brain'),
      state: { backend: 'mysql', jsonlPath: join(dir, 'jobs.jsonl'), mysql }, projects: {}, llmCredentials: {},
      executor: { hubUrl: '', token: '', executorId: 'synthetic', targets: [], waitMs: 100, concurrency: 1, labels: [] } };
    let closes = 0, recoveryPool: Pool | undefined;
    const originalClose = MysqlPoolOwner.prototype.close, originalUpdate = MysqlStore.prototype.updateJobIfStatus;
    t.mock.method(MysqlPoolOwner.prototype, 'close', async function (this: MysqlPoolOwner) { closes++; await originalClose.call(this); });
    t.mock.method(MysqlStore.prototype, 'updateJobIfStatus', async function (this: MysqlStore, ...args: Parameters<typeof originalUpdate>) {
      if (args[0] === 'synthetic-orphan' && args[2].status === 'queued') recoveryPool = (this as unknown as { pool: Pool }).pool;
      return await originalUpdate.apply(this, args);
    });
    kernel = createBailingHubKernel({ instanceKey: database, config, schedulerMode: 'standalone', bootstrapLocalAdmin: false,
      logger: { log() {}, warn() {}, error() {} } });
    server = kernel.createStandaloneServer({ exit() {} });
    await server.start();
    t.signal.throwIfAborted();

    let waitingOnSql = false;
    const lockDeadline = performance.now() + 10_000;
    while (performance.now() < lockDeadline) {
      t.signal.throwIfAborted();
      const [rows] = await admin.query<any[]>(`SELECT COUNT(*) n FROM performance_schema.data_lock_waits w
        JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID AND l.ENGINE=w.ENGINE
        WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='bz_jobs'`, [database]);
      if (Number(rows[0].n) > 0) { waitingOnSql = true; break; }
      await delay(10);
    }
    assert.equal(waitingOnSql, true, 'the real boot timer must reach an UPDATE blocked inside MySQL');
    t.diagnostic(`real MySQL row-lock wait observed in ${Math.round(performance.now() - startedAt)}ms`);
    await assert.rejects(kernel.close(10), /boot recovery drain timed out/);
    assert.equal(closes, 0, 'timing out cannot close the pool that owns the blocked UPDATE');
    assert.ok(recoveryPool);
    await recoveryPool.query('SELECT 1');

    const firstClose = kernel.close(5_000), secondClose = kernel.close(5_000);
    await lockConnection.rollback(); lockConnection.release(); lockConnection = undefined;
    await Promise.all([firstClose, secondClose]);
    await kernel.close(0);
    assert.equal(closes, 1);
    const [jobs] = await admin.query<any[]>(`SELECT status FROM \`${database}\`.bz_jobs WHERE job_id=?`, ['synthetic-orphan']);
    assert.equal(jobs[0].status, 'queued');
    const [audits] = await admin.query<any[]>(`SELECT COUNT(*) n FROM \`${database}\`.bz_audit WHERE job_id=? AND event='recovered'`, ['synthetic-orphan']);
    assert.equal(Number(audits[0].n), 1);
    await assert.rejects(recoveryPool.query('SELECT 1'));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>): Promise<boolean> => {
      try { await action(); return true; }
      catch (error) { cleanupErrors.push(error); return false; }
    };
    if (lockConnection) {
      const connection = lockConnection;
      lockConnection = undefined;
      if (await cleanup(() => connection.rollback())) connection.release();
      else connection.destroy();
    }
    // Each cleanup step must run even if an earlier one fails. A second normal
    // drain via shutdown may finish late SQL; never force-close its pool or drop
    // the schema while that SQL is still in flight.
    let drained = await cleanup(async () => { await kernel?.close(10_000); });
    if (server) drained = await cleanup(() => server!.shutdown('test')) || drained;
    if (created && drained) await cleanup(() => admin.query(`DROP DATABASE \`${database}\``));
    if (created && !drained) t.diagnostic(`cleanup could not drain runtime; retained disposable schema ${database}`);
    await cleanup(() => admin.end());
    await cleanup(() => rm(dir, { recursive: true, force: true }));
    t.signal.removeEventListener('abort', releaseTestLockOnAbort);
    if (cleanupErrors.length) throw new AggregateError(failure === undefined ? cleanupErrors : [failure, ...cleanupErrors], 'Synthetic boot recovery test cleanup failed');
  }
});
