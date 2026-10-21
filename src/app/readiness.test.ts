import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'mysql2/promise';
import type { AppConfig } from '../core/config/config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { SchemaReadinessDatabase } from '../core/contracts/schema-readiness';
import { BAILINGHUB_CORE_ARTIFACT_V1 as artifact } from '../kernel-api/v1/artifact';
import { MysqlStore } from '../infrastructure/state/state-mysql';
import { checkReadinessFor } from './readiness';

const cfg = (backend: 'mysql' | 'jsonl' = 'mysql') => ({ root: '/not-the-installed-artifact', state: { backend } }) as AppConfig;
const rows = () => artifact.migrations.map(file => ({ filename: file.filename, checksum_sha256: file.checksumSha256 }));
function database(payload: unknown = rows(), fail?: 'connection' | 'ledger') {
  const queries: string[] = [];
  const db: SchemaReadinessDatabase = { query: async sql => {
    queries.push(sql);
    assert.ok(sql === 'SELECT 1' || sql === 'SELECT filename, checksum_sha256 FROM bz_schema_migrations ORDER BY filename', 'only fixed read-only queries');
    if (fail === 'connection' || (fail === 'ledger' && sql !== 'SELECT 1')) throw new Error('mysql://secret@internal SQL error');
    return [sql === 'SELECT 1' ? [{ one: 1 }] : payload, []];
  } };
  return { db, queries };
}
const config = (db: SchemaReadinessDatabase) => ({ db }) as ConfigStoreContract;
const state = (db: SchemaReadinessDatabase) => ({ schemaReadinessDb: db });

test('shared actual pool is checked once; installed artifact does not depend on cfg.root', async () => {
  const { db, queries } = database();
  assert.deepEqual(await checkReadinessFor(cfg(), config(db), state(db)), {
    ready: true, checks: { state_backend: 'ok', database: 'ok', migrations: { status: 'ok', pending: 0 } },
  });
  assert.equal(queries.length, 2);
});

for (const missing of ['state', 'configuration']) {
  test(`split MySQL: missing migration on ${missing} prevents ready`, async () => {
    const stateDb = database(missing === 'state' ? rows().slice(0, -1) : rows());
    const configDb = database(missing === 'configuration' ? rows().slice(0, -1) : rows());
    const report = await checkReadinessFor(cfg(), config(configDb.db), state(stateDb.db));
    assert.equal(report.ready, false);
    assert.deepEqual(report.checks.migrations, { status: 'pending', pending: 1 });
    assert.equal(stateDb.queries.length, 2); assert.equal(configDb.queries.length, 2);
  });
}

test('pure JSONL skips SQL; JSONL state with a MySQL config still checks configuration', async () => {
  assert.equal((await checkReadinessFor(cfg('jsonl'), null)).checks.database, 'skipped');
  const incomplete = database(rows().slice(0, -1));
  const report = await checkReadinessFor(cfg('jsonl'), config(incomplete.db));
  assert.equal(report.ready, false); assert.equal(report.checks.migrations.pending, 1);
  assert.equal(incomplete.queries.length, 2);
});

test('custom MySQL store without an actual probe fails closed; no fallback connection', async () => {
  const { db, queries } = database();
  const report = await checkReadinessFor(cfg(), config(db), {});
  assert.equal(report.ready, false); assert.equal(report.checks.database, 'failed'); assert.equal(queries.length, 0);
});

test('existing MysqlStore pool is reused across probes, never closed or reacquired by readiness', async () => {
  const { db } = database(); let gets = 0; let closes = 0;
  const store = new MysqlStore({} as AppConfig['state']['mysql'], { get: async () => { gets++; return db as Pool; }, close: async () => { closes++; } });
  await store.init();
  for (let index = 0; index < 3; index++) assert.equal((await checkReadinessFor(cfg(), config(db), store)).ready, true);
  assert.equal(gets, 1); assert.equal(closes, 0); assert.equal(store.schemaReadinessDb, db);
  await store.close(); assert.equal(closes, 1);
});

for (const value of [null, '', ' ', '0'.repeat(64), 'invalid', undefined, 123]) {
  test(`missing/malformed/conflicting checksum (${String(value)}) is not ready and is never backfilled`, async () => {
    const payload: Array<Record<string, unknown>> = rows(); payload[0] = { ...payload[0], checksum_sha256: value };
    const original = structuredClone(payload); const { db } = database(payload);
    const report = await checkReadinessFor(cfg(), config(db), state(db));
    assert.equal(report.ready, false); assert.equal(report.checks.migrations.status, 'failed'); assert.deepEqual(payload, original);
  });
}

test('unknown future and duplicate migration rows fail closed', async () => {
  for (const payload of [[...rows(), { filename: '999_future.sql', checksum_sha256: '0'.repeat(64) }], [...rows(), rows()[0]]]) {
    const { db } = database(payload);
    assert.equal((await checkReadinessFor(cfg(), config(db), state(db))).checks.migrations.status, 'failed');
  }
});

test('retired history is optional, never pending; a present retired record must match its checksum', async () => {
  const retired = artifact.retiredMigrations[0]; assert.ok(retired);
  for (const checksum of [retired.checksumSha256, '0'.repeat(64), null]) {
    const { db } = database([...rows(), { filename: retired.filename, checksum_sha256: checksum }]);
    const report = await checkReadinessFor(cfg(), config(db), state(db));
    assert.equal(report.ready, checksum === retired.checksumSha256); assert.equal(report.checks.migrations.pending, 0);
  }
});

test('checksum normalization matches the migrator; invalid ledger shapes fail closed', async () => {
  const upper = rows().map(row => ({ ...row, checksum_sha256: ` ${row.checksum_sha256.toUpperCase()} ` }));
  const valid = database(upper).db; assert.equal((await checkReadinessFor(cfg(), config(valid), state(valid))).ready, true);
  for (const payload of [undefined, {}, [null], [['invalid']], [{ filename: 1, checksum_sha256: '0'.repeat(64) }]]) {
    const { db } = database(payload === undefined ? null : payload);
    assert.equal((await checkReadinessFor(cfg(), config(db), state(db))).ready, false);
  }
});

for (const fault of ['connection', 'ledger'] as const) {
  test(`unreachable DB or absent ledger/checksum column (${fault}) exposes stable states only`, async () => {
    const { db } = database(rows(), fault);
    const report = await checkReadinessFor(cfg(), config(db), state(db));
    assert.equal(report.ready, false); assert.equal(report.checks.database, fault === 'connection' ? 'failed' : 'ok');
    assert.equal(report.checks.migrations.status, 'failed'); assert.doesNotMatch(JSON.stringify(report), /secret|internal|SQL/);
  });
}

test('adapter getter failure is contained without leaking connection details', async () => {
  const broken = { get schemaReadinessDb(): SchemaReadinessDatabase { throw new Error('mysql://secret@internal'); } };
  const { db } = database(); const report = await checkReadinessFor(cfg(), config(db), broken);
  assert.equal(report.ready, false); assert.doesNotMatch(JSON.stringify(report), /secret|internal/);
});

test('pending counts distinct missing files across distinct pools without skipping either probe', async () => {
  const first = database(rows().slice(0, -1)); const second = database(rows().slice(0, -1));
  const report = await checkReadinessFor(cfg(), config(first.db), state(second.db));
  assert.equal(report.ready, false); assert.equal(report.checks.migrations.pending, 1);
  assert.equal(first.queries.length, 2); assert.equal(second.queries.length, 2);
});
