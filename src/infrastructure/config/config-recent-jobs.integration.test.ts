import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { ObservabilityLedger } from './config-observability-ledger';
import { migrateBailingHubCoreSchema } from '../schema/core-schema-migrator';
import { dtAt } from '../../core/config/config-codec';

test('job filters, time boundaries and stable continuation operate before pagination in MySQL',
  { skip: !process.env.BAILING_RUNS_TEST_MYSQL_PORT }, async () => {
    const database = 'dispatch_test_' + randomBytes(8).toString('hex');
    const connection = { host: '127.0.0.1', port: Number(process.env.BAILING_RUNS_TEST_MYSQL_PORT), user: 'root', password: '' };
    const admin = await mysql.createConnection(connection);
    const pool = mysql.createPool({ ...connection, database, timezone: 'Z', connectionLimit: 1 });
    try {
      await admin.query('CREATE DATABASE ' + database);
      await migrateBailingHubCoreSchema({ mysql: { ...connection, database, connectionLimit: 2 }, logger: { log() {}, warn() {} } });
      const ledger = new ObservabilityLedger(() => pool);
      const now = Date.parse('2026-10-21T10:00:00Z');
      await pool.query('SET timestamp=?', [now / 1000]);
      const id = (n: number) => '30000000-1111-4111-8111-' + String(n).padStart(12, '0');
      const row = (n: number, status: string, route: string, ageMs: number) =>
        [id(n), 'request-' + n, status, 'default', dtAt(now - ageMs), dtAt(now - ageMs), JSON.stringify({ route_key: route })];
      const days = 86400000;
      const records = Array.from({ length: 50 }, (_, i) => row(i + 2, 'done', 'orders', 0));
      records.push(row(1, 'error', 'orders', days), row(0, 'error', 'orders', 7 * days),
        row(70, 'error', 'orders-extra', days), row(71, 'error', 'orders', -1000));
      await pool.query('INSERT INTO bz_jobs(job_id,request_id,status,profile,created_at,updated_at,dispatch) VALUES ?', [records]);
      const first = await ledger.listRecentJobs(50, 0);
      assert.ok(!first.some(j => j.job_id === id(1)));
      assert.deepEqual((await ledger.listFilteredJobs(50, 0, { status: 'error', routeKey: 'orders', period: '24h' })).map(j => j.job_id), [id(1)]);
      assert.deepEqual((await ledger.listFilteredJobs(50, 0, { status: 'error', routeKey: 'orders', period: '7d' })).map(j => j.job_id), [id(1), id(0)]);
      const page = await ledger.listFilteredJobs(25, 0, { status: 'done' });
      const last = page.at(-1)!;
      await pool.query('INSERT INTO bz_jobs(job_id,request_id,status,profile,created_at,updated_at,dispatch) VALUES ?', [[row(80, 'done', 'orders', 0)]]);
      const next = await ledger.listFilteredJobs(25, 25, { status: 'done', before: { createdAt: +new Date(last.created_at), jobId: last.job_id } });
      assert.equal(next.length, 25);
      assert.equal(new Set([...page, ...next].map(j => j.job_id)).size, 50);
      assert.deepEqual([next[0].job_id, next.at(-1).job_id], [id(26), id(2)]);
    } finally {
      await pool.end();
      await admin.query('DROP DATABASE IF EXISTS ' + database);
      await admin.end();
    }
  });
