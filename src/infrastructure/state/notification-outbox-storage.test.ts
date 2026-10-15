import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { createPool } from 'mysql2/promise';
import type { Job } from '../../core/contracts/types';
import { JsonlStore } from './state-jsonl';
import { MysqlStore } from './state-mysql';
import { migrateBailingHubCoreSchema } from '../schema/core-schema-migrator';
import { ApprovalLedger } from '../config/config-approval-ledger';
import { DeliveryDlqLedger } from '../config/config-delivery-dlq-ledger';
import { MysqlNotificationOutbox } from './notification-outbox-mysql';
import type { ApprovalNotificationDraft } from '../../core/contracts/notification-outbox';
import { safeNotificationError } from '../../core/state/notification-outbox';

const mysqlEnabled = process.env.BAILING_NOTIFICATION_OUTBOX_TEST_MYSQL === '1';
const now = () => new Date().toISOString();
function job(patch: Partial<Job> = {}): Job {
  return { job_id: randomUUID(), request_id: `notification-${randomUUID()}`, status: 'running', target: 'llm', source: 'synthetic',
    profile: 'synthetic', project: '', input_preview: '', metadata: {}, callback_url: 'https://synthetic.invalid/callback',
    created_at: now(), updated_at: now(), ...patch };
}
async function fixture(backend: 'jsonl' | 'mysql', baselineRoot?: string) {
  if (backend === 'jsonl') {
    const dir = await mkdtemp(join(tmpdir(), 'notification-journal-'));
    const path = join(dir, 'state.jsonl'), store = new JsonlStore(path); await store.init();
    return { store, path, pool: null, mysql: null, close: async () => { await store.close(); await rm(dir, { recursive: true, force: true }); } };
  }
  const database = `notification_outbox_${randomUUID().replaceAll('-', '')}`;
  const mysql = { host: '127.0.0.1', port: Number(process.env.BAILING_NOTIFICATION_OUTBOX_TEST_MYSQL_PORT ?? 16307), user: 'root', password: '', database, connectionLimit: 8 };
  const admin = createPool({ ...mysql, database: undefined, timezone: 'Z' });
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  const pool = createPool({ ...mysql, timezone: 'Z' });
  try {
    const migrator = baselineRoot ? (await import(pathToFileURL(join(baselineRoot, 'src/infrastructure/schema/core-schema-migrator.ts')).href)).migrateBailingHubCoreSchema : migrateBailingHubCoreSchema;
    await migrator({ mysql, logger: { log() {}, warn() {} } });
    const store = new MysqlStore(mysql, { get: async () => pool, close: async () => {} }); await store.init();
    return { store, pool, mysql, path: '', close: async () => { await pool.end(); await admin.query(`DROP DATABASE \`${database}\``); await admin.end(); } };
  } catch (error) { await pool.end(); await admin.query(`DROP DATABASE \`${database}\``); await admin.end(); throw error; }
}

for (const backend of ['jsonl', 'mysql'] as const) {
  test(`${backend}: terminal transaction freezes payload, duplicates and stale completions cannot emit again`, { skip: backend === 'mysql' && !mysqlEnabled }, async () => {
    const h = await fixture(backend);
    try {
      const original = job({ claim_token: 'claim-1', dispatch: { delivery: { type: 'webhook', url: 'https://synthetic.invalid/delivery' } } });
      await h.store.createJob(original);
      await h.store.updateJob(original.job_id, { claim_token: 'claim-1' });
      assert.equal(await h.store.completeJobWithNotifications({ ...original, claim_token: 'stale' }, { status: 'done' }), null);
      const results = await Promise.all([1, 2].map(() => h.store.completeJobWithNotifications(original, { status: 'done', result: { text: 'first' } }, { brandName: 'Frozen brand' })));
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(await h.store.completeJobWithNotifications(original, { status: 'done', result: { text: 'overwrite' } }), null);
      const events = await h.store.notificationOutbox.list();
      assert.deepEqual(events.map(event => event.kind).sort(), ['callback', 'delivery']);
      assert.equal(events[0]!.payload.job.result?.['text'], 'first');
      assert.equal(events[0]!.payload.brand_name, 'Frozen brand');
      await h.store.updateJob(original.job_id, { status: 'queued', attempts: 0, claim_token: undefined });
      await h.store.updateJob(original.job_id, { status: 'running' });
      await h.store.completeJobWithNotifications((await h.store.getJob(original.job_id))!, { status: 'done', result: { text: 'second' } });
      const both = await h.store.notificationOutbox.list();
      assert.equal(both.length, 4);
      assert.equal(new Set(both.map(event => event.event_id)).size, 4);
      assert.equal(both.filter(event => event.payload.job.result?.['text'] === 'first').length, 2);
      assert.equal((await h.store.notificationOutbox.snapshot({ kinds: ['callback'] })).counts.pending, 2);
      assert.equal((await h.store.notificationOutbox.list({ kinds: ['callback'], limit: 1, offset: 1 })).length, 1);
      assert.equal((await h.store.notificationOutbox.list({ kinds: [] })).length, 0);
    } finally { await h.close(); }
  });

  test(`${backend}: ordinary terminal writes and TTL are durable; initial terminal and legacy state are not replayed`, { skip: backend === 'mysql' && !mysqlEnabled }, async () => {
    const h = await fixture(backend);
    try {
      await h.store.createJob(job({ status: 'done' }));
      assert.equal((await h.store.notificationOutbox.list()).length, 0);
      const queued = job({ status: 'queued', created_at: new Date(Date.now() - 60_000).toISOString() });
      await h.store.createJob(queued);
      assert.equal(await h.store.expireStaleQueued(1000), 1);
      assert.equal((await h.store.notificationOutbox.list()).length, 1);
      assert.equal(await h.store.expireStaleQueued(1000), 0);
      const rejected = job(); await h.store.createJob(rejected);
      await h.store.updateJobIfStatus(rejected.job_id, ['running'], { status: 'rejected' });
      const child = job({ source: 'delivery', target: 'sms-notify', callback_url: undefined }); await h.store.createJob(child);
      await h.store.updateJob(child.job_id, { status: 'error', error: 'synthetic' });
      assert.deepEqual((await h.store.notificationOutbox.list()).map(event => event.kind).sort(), ['callback', 'callback', 'delivery-dlq']);
      if (h.path) {
        const restarted = new JsonlStore(h.path); await restarted.init();
        assert.equal((await restarted.notificationOutbox.list()).length, 3);
        const records = (await readFile(h.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.ok(records.some(record => record.kind === 'job' && record.job.status === 'error' && record.notifications?.length));
      }
    } finally { await h.close(); }
  });

  test(`${backend}: leases, expired-owner fencing, uncertainty and manual retry preserve identity`, { skip: backend === 'mysql' && !mysqlEnabled }, async () => {
    const h = await fixture(backend);
    try {
      const original = job({ dispatch: { delivery: { type: 'channel', channel: 'synthetic', to: 'nobody' } } });
      await h.store.createJob(original); await h.store.completeJobWithNotifications(original, { status: 'done', result: { text: 'synthetic' } });
      const old = new Date(Date.now() - 20_000).toISOString();
      // Make the expired first claim without any external call.
      const claimed = await h.store.notificationOutbox.claim({ owner: 'old', leaseMs: 100, now: new Date(Date.now() + 1000).toISOString() });
      assert.equal(claimed.length, 2);
      if (h.pool) await h.pool.query('UPDATE bz_notification_outbox SET lease_until=?', [old.replace('T', ' ').replace('Z', '')]);
      else {
        await appendFile(h.path, JSON.stringify({ kind: 'notification-events', events: claimed.map(event => ({ ...event, lease_until: old })) }) + '\n');
        const reopened = new JsonlStore(h.path); await reopened.init(); h.store = reopened;
      }
      const callback = claimed.find(event => event.kind === 'callback')!, native = claimed.find(event => event.kind === 'delivery')!;
      assert.equal(await h.store.notificationOutbox.complete(callback.event_id, callback.lease_token!), false);
      assert.equal(await h.store.notificationOutbox.renew(callback.event_id, callback.lease_token!, 1000), false);
      const claims = await Promise.all([1, 2].map(i => h.store.notificationOutbox.claim({ owner: `worker-${i}`, leaseMs: 60_000 })));
      const all = claims.flat(); assert.equal(all.length, 1); assert.equal(all[0]!.event_id, callback.event_id);
      assert.equal((await h.store.notificationOutbox.get(native.event_id))?.status, 'uncertain');
      assert.equal(await h.store.notificationOutbox.retry(native.event_id), false);
      assert.equal(await h.store.notificationOutbox.retry(native.event_id, { allowUncertain: true, expectedStatus: 'failed' }), false);
      assert.equal(await h.store.notificationOutbox.retry(native.event_id, { allowUncertain: true, expectedStatus: 'uncertain' }), true);
      assert.equal((await h.store.notificationOutbox.get(native.event_id))?.attempts, 1);
      assert.equal((await h.store.notificationOutbox.get(native.event_id))?.cycle_attempts, 0);
      assert.equal(await h.store.notificationOutbox.fail(callback.event_id, all[0]!.lease_token!, { status: 'failed', error: 'https://secret.invalid/?token=secret' }), true);
      assert.equal((await h.store.notificationOutbox.get(callback.event_id))?.last_error, 'notification_delivery_failed');
      assert.equal(await h.store.notificationOutbox.retry(callback.event_id, { expectedStatus: 'failed' }), true);
      const renewed = (await h.store.notificationOutbox.claim({ owner: 'new', kinds: ['callback'], leaseMs: 1000 }))[0]!;
      assert.equal(renewed.attempts, 3); assert.equal(renewed.cycle_attempts, 1);
      assert.equal(await h.store.notificationOutbox.renew(renewed.event_id, renewed.lease_token!, 2000), true);
      assert.equal(await h.store.notificationOutbox.complete(renewed.event_id, renewed.lease_token!), true);
      assert.equal(await h.store.notificationOutbox.retry(renewed.event_id, { allowUncertain: true }), false);
      // A provider can return a secret which looks like a syntactically valid code.
      // Neither persistence nor get/list may promote it to an operator-visible code.
      for (const [unsafe, expected] of [
        ['SyntheticTokenA123456789', 'notification_delivery_failed'],
        ['private_customer_refund_details', 'notification_delivery_failed'],
        ['notification_unknown_private_suffix', 'notification_delivery_failed'],
        ['webhook_http_503', 'webhook_http_503'],
      ]) {
        const privateJob = job(); await h.store.createJob(privateJob);
        await h.store.completeJobWithNotifications(privateJob, { status: 'done' });
        const privateEvent = (await h.store.notificationOutbox.claim({ owner: 'privacy', kinds: ['callback'], limit: 1 }))[0]!;
        assert.equal(await h.store.notificationOutbox.fail(privateEvent.event_id, privateEvent.lease_token!, { status: 'failed', error: unsafe! }), true);
        assert.equal((await h.store.notificationOutbox.get(privateEvent.event_id))?.last_error, expected);
        assert.equal((await h.store.notificationOutbox.list({ kinds: ['callback'], statuses: ['failed'] })).find(event => event.event_id === privateEvent.event_id)?.last_error, expected);
        if (h.pool) {
          const [stored]: any = await h.pool.query('SELECT last_error FROM bz_notification_outbox WHERE event_id=?', [privateEvent.event_id]);
          assert.equal(stored[0].last_error, expected);
        } else if (unsafe !== expected) assert.ok(!(await readFile(h.path, 'utf8')).includes(unsafe!));
      }
    } finally { await h.close(); }
  });
}

test('notification error boundary accepts only known Core codes and exact HTTP status codes', () => {
  assert.equal(safeNotificationError(undefined), undefined);
  for (const code of ['notification_delivery_failed', 'notification_delivery_uncertain', 'notification_attempt_limit',
    'notification_child_binding_conflict', 'approval_notification_binding_conflict', 'webhook_acknowledgement_unavailable',
    'webhook_http_100', 'webhook_http_429', 'webhook_http_599']) assert.equal(safeNotificationError(code), code);
  for (const text of ['', 'SyntheticTokenA123456789', 'private_customer_refund_details', 'webhook_http_099', 'webhook_http_600',
    'webhook_http_500_secret', 'webhook_http_500\n', 'notification_attempt_limit:secret', 'NOTIFICATION_ATTEMPT_LIMIT']) {
    assert.equal(safeNotificationError(text), 'notification_delivery_failed');
  }
});

test('JSONL repairs only an incomplete tail, keeps valid no-newline records, and rejects damaged middle data', async () => {
  const h = await fixture('jsonl');
  try {
    const original = job(); await h.store.createJob(original);
    await h.store.completeJobWithNotifications(original, { status: 'done' });
    await appendFile(h.path, '{"kind":"job","job":');
    const reopened = new JsonlStore(h.path); await reopened.init();
    assert.equal((await reopened.getJob(original.job_id))?.status, 'done');
    assert.equal((await reopened.notificationOutbox.list()).length, 1);
    await reopened.createJob(job());
    const valid = await readFile(h.path, 'utf8');
    await writeFile(h.path, valid.trimEnd());
    await new JsonlStore(h.path).init();
    assert.ok((await readFile(h.path, 'utf8')).endsWith('\n'));
    await writeFile(h.path, '{bad}\n' + valid);
    await assert.rejects(new JsonlStore(h.path).init(), /jsonl_journal_corrupt_record/);
  } finally { await h.close(); }
});

test('JSONL failed append exposes no terminal state or intention, and refuses further writes until reopen', async () => {
  const h = await fixture('jsonl');
  try {
    const original = job(); await h.store.createJob(original);
    await rm(h.path); await mkdir(h.path);
    await assert.rejects(h.store.completeJobWithNotifications(original, { status: 'done' }));
    assert.equal((await h.store.getJob(original.job_id))?.status, 'running');
    assert.equal((await h.store.notificationOutbox.list()).length, 0);
    await assert.rejects(h.store.updateJob(original.job_id, { status: 'done' }), /jsonl_journal_reopen_required/);
  } finally { await h.close(); }
});

test('JSONL actual SIGKILL after file sync but before memory publication recovers the terminal and original event together', async () => {
  const h = await fixture('jsonl');
  const child = fork(fileURLToPath(new URL('../../test-support/notification-outbox-journal-crash-child.ts', import.meta.url)), [],
    { execArgv: ['--import', 'tsx'], env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const checkpoint = new Promise<any>((resolve, reject) => {
      child.once('message', (message: any) => message.error ? reject(new Error(message.error)) : resolve(message));
      child.once('error', reject);
      child.once('exit', () => reject(new Error('journal worker exited before its checkpoint')));
    });
    const exit = new Promise<NodeJS.Signals | null>(resolve => child.once('exit', (_code, signal) => resolve(signal)));
    const original = job(); child.send({ path: h.path, job: original });
    assert.equal((await checkpoint).stage, 'after-sync-before-memory-publication');
    assert.equal(await exit, 'SIGKILL');
    const reopened = new JsonlStore(h.path); await reopened.init();
    assert.equal((await reopened.getJob(original.job_id))?.status, 'done');
    const events = await reopened.notificationOutbox.list(); assert.equal(events.length, 1);
    assert.equal(events[0]!.payload.job.result?.['text'], 'synthetic committed');
    assert.equal(await reopened.completeJobWithNotifications(original, { status: 'done' }), null);
    const claimed = await reopened.notificationOutbox.claim({ owner: 'restarted' });
    assert.equal(claimed[0]!.event_id, events[0]!.event_id);
    assert.equal((await reopened.getJob(original.job_id))?.status, 'done', 'recovering a notification never requeues its business parent');
  } finally { clearTimeout(timeout); child.kill('SIGKILL'); await h.close(); }
});

test('MySQL terminal transaction rolls back on outbox failure; lost COMMIT response does not duplicate intentions', { skip: !mysqlEnabled }, async () => {
  const h = await fixture('mysql');
  try {
    const original = job(); await h.store.createJob(original);
    let fault: 'insert' | 'commit' = 'insert';
    const store = new MysqlStore(h.mysql!, { close: async () => {}, get: async () => ({ ...h.pool!, getConnection: async () => {
      const connection = await h.pool!.getConnection(), query = connection.query.bind(connection), commit = connection.commit.bind(connection);
      connection.query = (async (sql: any, values: any) => {
        if (String(sql).startsWith('INSERT INTO bz_notification_outbox') && fault === 'insert') throw new Error('synthetic_outbox_failure');
        return query(sql, values);
      }) as any;
      connection.commit = async () => { await commit(); if (fault === 'commit') throw new Error('synthetic_commit_response_lost'); };
      const release = connection.release.bind(connection);
      connection.release = () => { connection.query = query as any; connection.commit = commit; release(); };
      return connection;
    } }) as any });
    await store.init();
    await assert.rejects(store.completeJobWithNotifications(original, { status: 'done' }), /synthetic_outbox_failure/);
    assert.equal((await h.store.getJob(original.job_id))?.status, 'running');
    assert.equal((await h.store.notificationOutbox.list()).length, 0);
    fault = 'commit';
    await assert.rejects(store.completeJobWithNotifications(original, { status: 'done' }), /synthetic_commit_response_lost/);
    assert.equal((await h.store.getJob(original.job_id))?.status, 'done');
    assert.equal((await h.store.notificationOutbox.list()).length, 1);
    assert.equal(await h.store.completeJobWithNotifications(original, { status: 'done' }), null);
  } finally { await h.close(); }
});

test('MySQL approval creation and frozen notification share the owning transaction, including lost COMMIT acknowledgement', { skip: !mysqlEnabled }, async () => {
  const h = await fixture('mysql');
  try {
    const original = job(); await h.store.createJob(original);
    const approval = { job_id: original.job_id, request_id: original.request_id, provider: 'synthetic', tool: 'synthetic_tool', scope: 'synthetic.write', risk: 'high', args_hash: 'a'.repeat(64), args_json: '{"x":1}' };
    const draft: ApprovalNotificationDraft = { job: original, provider_name: 'synthetic', subject: 'synthetic-subject', brand_name: 'Frozen',
      snap: { tool: approval.tool, scope: approval.scope, risk: 'high', policy: 'approval', reason: 'synthetic', method: 'POST', path: '/synthetic', args_json: approval.args_json, args_hash: approval.args_hash },
      destination: { type: 'webhook', url: 'https://synthetic.invalid/approval' } };
    let fault: 'insert' | 'commit' = 'insert';
    const ledger = new ApprovalLedger(() => ({ getConnection: async () => {
      const connection = await h.pool!.getConnection(), query = connection.query.bind(connection), commit = connection.commit.bind(connection), release = connection.release.bind(connection);
      connection.query = (async (sql: any, values: any) => {
        if (String(sql).startsWith('INSERT INTO bz_notification_outbox') && fault === 'insert') throw new Error('synthetic_intent_failure');
        return query(sql, values);
      }) as any;
      connection.commit = async () => { await commit(); if (fault === 'commit') throw new Error('synthetic_approval_commit_lost'); };
      connection.release = () => { connection.query = query as any; connection.commit = commit; release(); };
      return connection;
    } }));
    await assert.rejects(ledger.createWithNotification(approval, draft), /synthetic_intent_failure/);
    const goodLedger = new ApprovalLedger(() => h.pool!);
    assert.equal(await goodLedger.find(original.job_id, approval.tool, approval.args_hash, 'pending'), null);
    assert.equal((await h.store.notificationOutbox.list()).length, 0);
    fault = 'commit';
    await assert.rejects(ledger.createWithNotification(approval, draft), /synthetic_approval_commit_lost/);
    const saved = await goodLedger.find(original.job_id, approval.tool, approval.args_hash, 'pending'); assert.ok(saved);
    const configOutbox = new MysqlNotificationOutbox(() => h.pool!);
    const events = await configOutbox.list({ kinds: ['approval-notification'] }); assert.equal(events.length, 1);
    assert.equal(events[0]!.event_id, `approval:${saved.id}`);
    assert.equal((events[0]!.payload as ApprovalNotificationDraft).destination?.url, 'https://synthetic.invalid/approval');
    assert.equal((await h.store.notificationOutbox.list({ kinds: ['callback', 'delivery', 'delivery-dlq'] })).length, 0);
    assert.equal((await h.store.notificationOutbox.claim({ owner: 'state', kinds: ['callback', 'delivery', 'delivery-dlq'] })).length, 0);
    assert.equal((await configOutbox.claim({ owner: 'config', kinds: ['approval-notification'] })).length, 1);
    await assert.rejects(goodLedger.createWithNotification(approval, { ...draft, subject: 'test', job: { ...original, job_id: 'other' } }), /binding_mismatch/);
  } finally { await h.close(); }
});

test('MySQL durable DLQ event identity deduplicates concurrent creation and retains resolved status', { skip: !mysqlEnabled }, async () => {
  const h = await fixture('mysql');
  try {
    const ledger = new DeliveryDlqLedger(() => h.pool!);
    const record = { parentJobId: 'synthetic-parent', channel: 'synthetic-channel', recipient: 'synthetic-recipient', content: 'synthetic payload', error: 'synthetic_failure', deliveryKind: 'native_channel' as const, eventId: `synthetic:${randomUUID()}` };
    await Promise.all(Array.from({ length: 8 }, () => ledger.record(record)));
    const rows = await ledger.list(); assert.equal(rows.length, 1); assert.equal(rows[0]!.event_id, record.eventId);
    assert.equal((await ledger.get(rows[0]!.id))?.event_id, record.eventId);
    await ledger.resolveByEventId(record.eventId); await ledger.record(record);
    assert.equal((await ledger.get(rows[0]!.id))?.resolved, true);
    await assert.rejects(ledger.record({ ...record, recipient: 'different' }), /notification_dlq_identity_conflict/);
    await ledger.record({ ...record, eventId: undefined }); await ledger.record({ ...record, eventId: undefined });
    assert.equal((await ledger.list(true)).length, 3, 'legacy rows without event identities keep their existing semantics');
  } finally { await h.close(); }
});

const baselineRoot = process.env.BAILING_NOTIFICATION_OUTBOX_BASELINE_ROOT;
test('MySQL 067 -> 068 migration preserves original rows and checksums, adds no retrospective notifications, and runs once', { skip: !mysqlEnabled || !baselineRoot }, async () => {
  const h = await fixture('mysql', baselineRoot);
  try {
    const original = job({ status: 'done', result: { text: 'legacy immutable' } }); await h.store.createJob(original);
    await h.pool!.query("INSERT INTO bz_delivery_dlq(parent_job_id,channel,recipient,content,error,resolved,created_at) VALUES (?,?,?,?,?,0,NOW())", [original.job_id, 'legacy', 'synthetic', 'legacy body', 'legacy error']);
    const [beforeJobs]: any = await h.pool!.query('SELECT * FROM bz_jobs');
    const [beforeDlq]: any = await h.pool!.query('SELECT * FROM bz_delivery_dlq');
    const [beforeMigrations]: any = await h.pool!.query('SELECT filename,checksum_sha256 FROM bz_schema_migrations ORDER BY filename');
    const result = await migrateBailingHubCoreSchema({ mysql: h.mysql!, logger: { log() {}, warn() {} } });
    assert.deepEqual(result.appliedFiles, ['068_notification_outbox.sql']);
    const [afterJobs]: any = await h.pool!.query('SELECT * FROM bz_jobs');
    const [afterDlq]: any = await h.pool!.query('SELECT * FROM bz_delivery_dlq');
    assert.deepEqual(afterJobs, beforeJobs);
    assert.deepEqual(afterDlq.map(({ event_id: _event, ...row }: any) => row), beforeDlq);
    assert.equal(afterDlq[0].event_id, null);
    assert.equal((await h.store.notificationOutbox.list()).length, 0);
    assert.equal((await migrateBailingHubCoreSchema({ mysql: h.mysql!, logger: { log() {}, warn() {} } })).appliedFiles.length, 0);
    const [afterMigrations]: any = await h.pool!.query('SELECT filename,checksum_sha256 FROM bz_schema_migrations WHERE filename<>? ORDER BY filename', ['068_notification_outbox.sql']);
    assert.deepEqual(afterMigrations, beforeMigrations);
  } finally { await h.close(); }
});
