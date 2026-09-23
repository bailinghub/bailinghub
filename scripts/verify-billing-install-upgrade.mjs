// Local-only synthetic release acceptance. Never loads application configuration.
// Run: node --import tsx scripts/verify-billing-install-upgrade.mjs
// Requires an isolated MySQL at 127.0.0.1:16307 (root, empty password).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnection, createPool } from 'mysql2/promise';
import { migrateBailingHubCoreSchema } from '../src/infrastructure/schema/core-schema-migrator.ts';
import { UsageRepository } from '../src/modules/usage/repository.ts';
import { getUsageIdentity } from '../src/modules/usage/identity.ts';
import { getBillingRepository } from '../src/modules/usage/billing-repository.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const mysql = Object.freeze({ host: '127.0.0.1', port: 16307, user: 'root', password: '',
  connectionLimit: 2, connectTimeout: 5_000, dateStrings: true,
  supportBigNumbers: true, bigNumberStrings: true });
const expectedAdditions = ['063_usage_model_billing.sql', '064_period_plan_allowance.sql'];
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
const digest = data => createHash('sha256').update(data).digest('hex');
const quote = identifier => { assert.match(identifier, /^[a-zA-Z0-9_]+$/); return `\`${identifier}\``; };
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]),
  );
  return value;
};

async function manifest(directory) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  return Promise.all(names.map(async filename => ({ filename,
    checksum_sha256: digest(await readFile(join(directory, filename))) })));
}

async function stageBaseline(baselineRoot, revision) {
  // Extract only the local public tag's SQL and official migrator dependencies.
  const names = git('ls-tree', '-r', '--name-only', revision, 'sql', 'src/infrastructure/schema')
    .toString().trim().split('\n').filter(name => name.endsWith('.sql')
      || name.endsWith('.ts') && !name.endsWith('.test.ts'));
  for (const name of names) {
    const destination = join(baselineRoot, name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, git('show', `${revision}:${name}`));
  }
  await writeFile(join(baselineRoot, 'package.json'), '{"type":"module"}\n');
  return import(pathToFileURL(join(baselineRoot, 'src/infrastructure/schema/core-schema-migrator.ts')).href);
}

async function tables(connection) {
  const [rows] = await connection.query('SHOW FULL TABLES WHERE Table_type = ?', ['BASE TABLE']);
  return rows.map(row => Object.values(row)[0]).sort();
}

async function snapshot(connection, names) {
  const result = {};
  for (const table of names) {
    const [rows] = await connection.query(`SELECT * FROM ${quote(table)}`);
    const [ddl] = await connection.query(`SHOW CREATE TABLE ${quote(table)}`);
    const serialized = rows.map(row => JSON.stringify(canonical(row))).sort();
    result[table] = { rowCount: rows.length, rowsSha256: digest(JSON.stringify(serialized)),
      schemaSha256: digest(ddl[0]['Create Table']) };
  }
  return result;
}

async function verifyLedger(connection, expected) {
  const [rows] = await connection.query(
    'SELECT filename, checksum_sha256 FROM bz_schema_migrations ORDER BY filename',
  );
  assert.deepEqual(rows.map(row => ({ ...row })), expected);
}

async function seedLegacyRecords(connection) {
  const date = '2026-01-02 03:04:05', expires = '2036-01-02 03:04:05';
  const session = randomUUID(), job = randomUUID(), authorization = randomUUID();
  const client = 'synthetic-upgrade-client', route = 'synthetic-upgrade-route';
  const principal = JSON.stringify({ tenant: 'synthetic', id: 'upgrade-user' });
  const routes = JSON.stringify([route]);
  const fixtures = [
    ['bz_clients', { app_id: client, name: 'Synthetic existing integration', token: '0'.repeat(32),
      allowed_routes: routes, created_at: date, updated_at: date }],
    ['bz_routes', { route_key: route, name: 'Synthetic existing route', created_at: date, updated_at: date }],
    ['bz_agent_sessions', { session_id: session, client_app_id: client, device_label: 'Synthetic device',
      principal_json: principal, on_behalf_of: 'upgrade-user', allowed_routes: routes,
      access_token_hash: '1'.repeat(64), access_expires_at: expires, refresh_expires_at: expires,
      created_at: date, updated_at: date, subject_display: JSON.stringify({ name: 'Synthetic person' }) }],
    ['bz_agent_authorizations', { authorization_id: authorization, client_app_id: client,
      redirect_uri: 'http://127.0.0.1:1/synthetic-callback', state_value: 'synthetic-state',
      requested_routes: routes, device_label: 'Synthetic device', code_challenge: 'x'.repeat(43),
      status: 'consumed', principal_json: principal, on_behalf_of: 'upgrade-user', allowed_routes: routes,
      session_id: session, created_at: date, expires_at: expires, consumed_at: date }],
    ['bz_agent_refresh_tokens', { token_hash: '2'.repeat(64), session_id: session,
      status: 'used', created_at: date, expires_at: expires, used_at: date }],
    ['bz_jobs', { job_id: job, request_id: 'synthetic-original-request', profile: 'readonly',
      status: 'done', client_app_id: client, agent_session_id: session, on_behalf_of: 'upgrade-user',
      result: JSON.stringify({ text: 'Original synthetic result' }), created_at: date, updated_at: date }],
    ['bz_audit', { ts: date, job_id: job, request_id: 'synthetic-original-request', event: 'finished',
      detail: JSON.stringify({ preserved: true, fixture: 'upgrade' }) }],
    ['bz_approvals', { job_id: job, action: JSON.stringify({ synthetic: true }), status: 'approved',
      decided_by: 'synthetic-reviewer', created_at: date, decided_at: date }],
  ];
  for (const [table, record] of fixtures) await connection.query('INSERT INTO ?? SET ?', [table, record]);
  return fixtures.map(([table]) => table);
}

async function verifyOptionalBilling(connection, database) {
  const usageTables = (await tables(connection)).filter(table => table.startsWith('bz_usage_'));
  assert.equal(usageTables.length, 14);
  const before = await snapshot(connection, usageTables);
  for (const [table, value] of Object.entries(before)) assert.equal(value.rowCount, 0, `${table} must be empty`);
  const pool = createPool({ ...mysql, database });
  try {
    const repository = new UsageRepository(() => pool);
    assert.equal(await getUsageIdentity(repository).ready(), true);
    assert.equal(await getBillingRepository(repository).ready(), true);
    assert.deepEqual(await getBillingRepository(repository).listPlans(), []);
  } finally { await pool.end(); }
  assert.deepEqual(await snapshot(connection, usageTables), before,
    'Readiness and listing must not create identities, plans, grants, requests or charges');
  return { tables: usageTables.length, allEmpty: true, schemaReady: true, autoProvisioned: false };
}

function assertNoReplay(result, expectedFiles) {
  assert.deepEqual(result.appliedFiles, []);
  assert.deepEqual(result.skippedFiles, expectedFiles);
  assert.deepEqual(result.checksumBackfilledFiles, []);
  assert.equal(result.executedStatements, 0);
  assert.equal(result.toleratedStatements, 0);
}

const baselineRoot = await mkdtemp(join(tmpdir(), 'bailing-billing-upgrade-'));
let admin;
const createdDatabases = new Set();
async function isolatedDatabase(label, callback) {
  const database = `billing_install_${label}_${randomUUID().replaceAll('-', '')}`;
  assert.match(database, /^billing_install_(fresh|upgrade)_[a-f0-9]{32}$/);
  await admin.query(`CREATE DATABASE ${quote(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  createdDatabases.add(database);
  let connection;
  try {
    connection = await createConnection({ ...mysql, database });
    return await callback(connection, database);
  } finally {
    if (connection) await connection.end();
    await admin.query(`DROP DATABASE ${quote(database)}`);
    createdDatabases.delete(database);
  }
}

try {
  const baselineRevision = git('rev-parse', 'v0.8.0^{commit}').toString().trim();
  const candidateHead = git('rev-parse', 'HEAD').toString().trim();
  const { migrateBailingHubCoreSchema: migrateBaseline } = await stageBaseline(baselineRoot, baselineRevision);
  const baselineManifest = await manifest(join(baselineRoot, 'sql'));
  const currentManifest = await manifest(join(root, 'sql'));
  const baselineNames = baselineManifest.map(file => file.filename);
  const currentNames = currentManifest.map(file => file.filename);
  assert.deepEqual(currentNames.filter(name => !baselineNames.includes(name)), expectedAdditions);
  for (const oldFile of baselineManifest) assert.deepEqual(
    currentManifest.find(file => file.filename === oldFile.filename), oldFile,
    `Published migration ${oldFile.filename} must remain byte-identical`,
  );
  admin = await createConnection(mysql);
  const [[server]] = await admin.query('SELECT VERSION() AS version');
  const fresh = await isolatedDatabase('fresh', async (connection, database) => {
    const input = { mysql: { ...mysql, database }, connection };
    assert.deepEqual(await tables(connection), []);
    const install = await migrateBailingHubCoreSchema(input);
    assert.deepEqual(install.appliedFiles, currentNames);
    assert.deepEqual(install.skippedFiles, []);
    await verifyLedger(connection, currentManifest);
    const billing = await verifyOptionalBilling(connection, database);
    const before = await snapshot(connection, await tables(connection));
    const rerun = await migrateBailingHubCoreSchema(input);
    assertNoReplay(rerun, currentNames);
    assert.deepEqual(await snapshot(connection, await tables(connection)), before);
    return { migrations: install.appliedFiles.length, executedStatements: install.executedStatements,
      toleratedStatements: install.toleratedStatements, tables: Object.keys(before).length,
      rerunExecutedStatements: rerun.executedStatements, billing };
  });
  const upgrade = await isolatedDatabase('upgrade', async (connection, database) => {
    const input = { mysql: { ...mysql, database }, connection };
    const initial = await migrateBaseline(input);
    assert.deepEqual(initial.appliedFiles, baselineNames);
    await verifyLedger(connection, baselineManifest);
    assert.equal((await tables(connection)).some(table => table.startsWith('bz_usage_')), false);
    const seededTables = await seedLegacyRecords(connection);
    const legacyTables = (await tables(connection)).filter(table => table !== 'bz_schema_migrations');
    const before = await snapshot(connection, legacyTables);
    const [oldLedger] = await connection.query('SELECT * FROM bz_schema_migrations ORDER BY filename');
    const migrated = await migrateBailingHubCoreSchema(input);
    assert.deepEqual(migrated.appliedFiles, expectedAdditions);
    assert.deepEqual(migrated.skippedFiles, baselineNames);
    assert.deepEqual(migrated.checksumBackfilledFiles, []);
    await verifyLedger(connection, currentManifest);
    const [newLedger] = await connection.query('SELECT * FROM bz_schema_migrations ORDER BY filename');
    assert.deepEqual(newLedger.filter(row => baselineNames.includes(row.filename)), oldLedger);
    assert.deepEqual(await snapshot(connection, legacyTables), before,
      'Every original table schema and row must be preserved');
    const billing = await verifyOptionalBilling(connection, database);
    const complete = await snapshot(connection, await tables(connection));
    const rerun = await migrateBailingHubCoreSchema(input);
    assertNoReplay(rerun, currentNames);
    assert.deepEqual(await snapshot(connection, await tables(connection)), complete);
    return { baselineMigrations: initial.appliedFiles.length, appliedMigrations: migrated.appliedFiles,
      executedStatements: migrated.executedStatements, preservedTables: legacyTables.length,
      preservedRows: Object.values(before).reduce((total, value) => total + value.rowCount, 0),
      seededTables, originalLedgerPreserved: true, oldSchemaAndDataPreserved: true,
      rerunExecutedStatements: rerun.executedStatements, billing };
  });
  console.log(JSON.stringify({ status: 'passed', baselineRevision, candidateHead, mysqlVersion: server.version,
    publishedSqlUnchanged: true, baselineSqlManifestSha256: digest(JSON.stringify(baselineManifest)),
    currentSqlManifestSha256: digest(JSON.stringify(currentManifest)), fresh, upgrade,
    syntheticDatabasesRemoved: createdDatabases.size === 0 }, null, 2));
} finally {
  if (admin) {
    for (const database of createdDatabases) await admin.query(`DROP DATABASE ${quote(database)}`);
    await admin.end();
  }
  await rm(baselineRoot, { recursive: true, force: true });
}
