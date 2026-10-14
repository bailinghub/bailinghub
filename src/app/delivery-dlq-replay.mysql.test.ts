import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPool } from 'mysql2/promise';
import type { Job } from '../core/contracts/types';
import { DeliveryDlqLedger } from '../infrastructure/config/config-delivery-dlq-ledger';
import { MysqlStore } from '../infrastructure/state/state-mysql';
import { migrateBailingHubCoreSchema } from '../infrastructure/schema/core-schema-migrator';
import { classifyDeliveryDlq, replayExecutorDeliveryDlq } from './delivery-dlq-replay';

const enabled = process.env.BAILING_NOTIFICATION_TEST_MYSQL === '1';
const baselineRoot = process.env.BAILING_NOTIFICATION_BASELINE_ROOT;
const migrationName = '067_delivery_dlq_replay.sql';

async function fixture(upgrade = false) {
  const database = `notification_acceptance_${randomUUID().replaceAll('-', '')}`;
  const mysql = { host: '127.0.0.1', port: Number(process.env.BAILING_NOTIFICATION_TEST_MYSQL_PORT ?? 16307), user: 'root', password: '', database, connectionLimit: 8 };
  const admin = createPool({ ...mysql, database: undefined });
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  const pool = createPool({ ...mysql, timezone: 'Z' });
  try {
    if (upgrade) {
      assert.ok(baselineRoot, 'explicit baseline root is required for upgrade acceptance');
      const baseline = await import(pathToFileURL(resolve(baselineRoot, 'src/infrastructure/schema/core-schema-migrator.ts')).href);
      await baseline.migrateBailingHubCoreSchema({ mysql, logger: { log() {}, warn() {} } });
    } else await migrateBailingHubCoreSchema({ mysql, logger: { log() {}, warn() {} } });
    const store = new MysqlStore(mysql, { get: async () => pool, close: async () => {} }); await store.init();
    const ledger = new DeliveryDlqLedger(() => pool);
    const stamp = new Date().toISOString();
    const child: Job = { job_id: randomUUID(), request_id: `deliver-${randomUUID()}`, status: 'error', target: 'sms-notify',
      profile: 'delivery', project: '', source: 'delivery', input: 'synthetic notification', input_preview: 'synthetic',
      metadata: { to: 'synthetic-recipient', parent_job_id: 'synthetic-business-parent' }, created_at: stamp, updated_at: stamp };
    const parent: Job = { ...child, job_id: randomUUID(), request_id: `business-${randomUUID()}`, source: 'business', target: 'llm' };
    await store.createJob(child); await store.createJob(parent);
    // Seed old-format rows even in fresh-schema tests to retain legacy coverage.
    const [first]: any = await pool.query('INSERT INTO bz_delivery_dlq (parent_job_id,channel,recipient,content,error,resolved,created_at) VALUES (?,?,?,?,?,0,NOW())',
      [child.job_id, child.target, 'synthetic-recipient', child.input, 'synthetic failure']);
    const executorId = Number(first.insertId);
    const [second]: any = await pool.query('INSERT INTO bz_delivery_dlq (parent_job_id,channel,recipient,content,error,resolved,created_at) VALUES (?,?,?,?,?,0,NOW())',
      [parent.job_id, 'native-notify', 'synthetic-recipient', parent.input, 'synthetic failure']);
    const nativeId = Number(second.insertId);
    return { mysql, pool, store, ledger, child, parent, executorId, nativeId,
      close: async () => { await pool.end(); await admin.query(`DROP DATABASE \`${database}\``); await admin.end(); } };
  } catch (error) {
    await pool.end(); await admin.query(`DROP DATABASE \`${database}\``); await admin.end(); throw error;
  }
}

test('MySQL v0.9.2 data upgrades to 067 once and preserves old native/executor records', { skip: !enabled || !baselineRoot }, async () => {
  const h = await fixture(true);
  try {
    const [before]: any = await h.pool.query('SELECT id,parent_job_id,channel,recipient,content,error,resolved FROM bz_delivery_dlq ORDER BY id');
    const upgrade = await migrateBailingHubCoreSchema({ mysql: h.mysql, logger: { log() {}, warn() {} } });
    assert.deepEqual(upgrade.appliedFiles, [migrationName]);
    const [after]: any = await h.pool.query('SELECT id,parent_job_id,channel,recipient,content,error,resolved FROM bz_delivery_dlq ORDER BY id');
    assert.deepEqual(after, before);
    assert.equal(await classifyDeliveryDlq((await h.ledger.get(h.executorId))!, h.store), 'executor_target');
    assert.equal(await classifyDeliveryDlq((await h.ledger.get(h.nativeId))!, h.store), 'native_channel');
    const [ledgerBefore]: any = await h.pool.query('SELECT filename,checksum_sha256 FROM bz_schema_migrations ORDER BY filename');
    const second = await migrateBailingHubCoreSchema({ mysql: h.mysql, logger: { log() {}, warn() {} } });
    assert.equal(second.appliedFiles.length, 0);
    const [ledgerAfter]: any = await h.pool.query('SELECT filename,checksum_sha256 FROM bz_schema_migrations ORDER BY filename');
    assert.deepEqual(ledgerAfter, ledgerBefore);
    const checksum = createHash('sha256').update(await readFile(new URL('../../sql/067_delivery_dlq_replay.sql', import.meta.url))).digest('hex');
    assert.equal(ledgerAfter.find((r: any) => r.filename === migrationName)?.checksum_sha256, checksum);
  } finally { await h.close(); }
});

test('MySQL concurrent DLQ identity and notification admission have one winner', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const identities = await Promise.all(Array.from({ length: 8 }, () => h.ledger.ensureExecutorReplay(h.executorId, h.child.job_id)));
    assert.equal(identities.filter(x => x?.created).length, 1);
    const input = { dlq_id: h.executorId, replay_key: identities[0]!.key, job_id: h.child.job_id, request_id: h.child.request_id, target: h.child.target! };
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => h.store.requeueDeliveryJobOnce(input)));
    assert.equal(outcomes.filter(x => x === 'queued').length, 1);
    assert.equal(outcomes.filter(x => x === 'already_queued').length, 7);
    assert.equal((await h.store.getJob(h.parent.job_id))?.status, 'error');
    assert.equal((await h.store.getJob(h.child.job_id))?.delivery_replay_keys?.[String(h.executorId)], input.replay_key);
    assert.ok(await h.store.claimNextJob(['sms-notify'], 'synthetic-executor', 1000));
    assert.equal(await h.store.claimNextJob(['sms-notify'], 'synthetic-executor-2', 1000), null);
  } finally { await h.close(); }
});

test('MySQL durable queued marker survives lost COMMIT/resolve replies and completed child retry', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const row = (await h.ledger.get(h.executorId))!;
    const marker = await h.ledger.ensureExecutorReplay(h.executorId, h.child.job_id);
    const faulty = new MysqlStore(h.mysql, { get: async () => ({ getConnection: async () => {
      const conn = await h.pool.getConnection(); const commit = conn.commit.bind(conn);
      conn.commit = async () => { conn.commit = commit; await commit(); throw new Error('synthetic queue COMMIT reply lost'); };
      return conn;
    } } as any), close: async () => {} }); await faulty.init();
    await assert.rejects(faulty.requeueDeliveryJobOnce({ dlq_id: row.id, replay_key: marker!.key, job_id: h.child.job_id,
      request_id: h.child.request_id, target: h.child.target! }), /COMMIT reply lost/);
    assert.equal((await h.store.getJob(h.child.job_id))?.status, 'queued');
    let failResolve = true;
    const resolve = h.ledger.resolve.bind(h.ledger);
    h.ledger.resolve = async id => { if (failResolve) { failResolve = false; throw new Error('synthetic resolve interruption'); } await resolve(id); };
    await assert.rejects(replayExecutorDeliveryDlq((await h.ledger.get(row.id))!, h.ledger, h.store), /resolve interruption/);
    await h.store.updateJob(h.child.job_id, { status: 'done', delivery_replay_keys: {} });
    const restarted = new MysqlStore(h.mysql, { get: async () => h.pool, close: async () => {} }); await restarted.init();
    assert.deepEqual(await replayExecutorDeliveryDlq((await h.ledger.get(row.id))!, h.ledger, restarted), { queued: false, duplicate: true });
    assert.equal((await restarted.getJob(h.child.job_id))?.status, 'done');
    assert.equal((await h.ledger.get(row.id))?.resolved, true);
  } finally { await h.close(); }
});

test('MySQL executor replay rejects a business Job and mismatched recipient/content', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    await h.pool.query("UPDATE bz_delivery_dlq SET delivery_kind='executor_target',notification_job_id=? WHERE id=?", [h.parent.job_id, h.nativeId]);
    await assert.rejects(replayExecutorDeliveryDlq((await h.ledger.get(h.nativeId))!, h.ledger, h.store), /binding_conflict/);
    await h.pool.query('UPDATE bz_delivery_dlq SET recipient=? WHERE id=?', ['wrong-recipient', h.executorId]);
    await assert.rejects(replayExecutorDeliveryDlq((await h.ledger.get(h.executorId))!, h.ledger, h.store), /binding_conflict/);
    assert.equal((await h.store.getJob(h.child.job_id))?.status, 'error');
    assert.equal((await h.store.getJob(h.parent.job_id))?.status, 'error');
  } finally { await h.close(); }
});

test('MySQL DLQ stores a UTF-8 byte-bounded long Chinese payload and replays the original full child', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const content = '汉'.repeat(60001);
    await h.store.updateJob(h.child.job_id, { input: content });
    await h.ledger.record({ parentJobId: h.child.job_id, channel: h.child.target!, recipient: 'synthetic-recipient', content,
      error: 'synthetic failure', deliveryKind: 'executor_target', notificationJobId: h.child.job_id });
    const [rows]: any = await h.pool.query('SELECT id FROM bz_delivery_dlq ORDER BY id DESC LIMIT 1');
    const row = (await h.ledger.get(Number(rows[0].id)))!;
    assert.equal(Buffer.byteLength(row.content), 60000);
    assert.equal(await classifyDeliveryDlq(row, h.store), 'executor_target');
    assert.equal((await replayExecutorDeliveryDlq(row, h.ledger, h.store)).queued, true);
    assert.equal((await h.store.getJob(h.child.job_id))?.input, content);
  } finally { await h.close(); }
});
