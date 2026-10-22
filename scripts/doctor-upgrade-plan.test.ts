import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BAILINGHUB_CORE_ARTIFACT_V1, type BailingHubCoreArtifactManifestV1 as Manifest } from '../src/kernel-api/v1/artifact';
import { runUpgradePlan, compareVersions, type UpgradeSnapshot, type UpgradePlanOptions } from './doctor-upgrade-plan';
const ID = '1'.repeat(64); const OTHER = '2'.repeat(64); const SECRET = 'private-credential-never-print';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function manifest(version: string, files: string[], retired = false): Manifest {
  const migrations = files.map((filename) => ({ filename, checksumSha256: sha(`-- ${filename}\n`) }));
  const retiredMigrations = retired ? [{ filename: '020_retired.sql', checksumSha256: sha('old bytes'), byteLength: 9, replay: 'never' as const }] : [];
  const manifestSha256 = createHash('sha256').update('bailinghub-core-artifact-v1').update('\0').update(version).update('\0active\0')
    .update(migrations.map((m) => `${m.filename}\0${m.checksumSha256}`).join('\n')).update('\0retired\0')
    .update(retiredMigrations.map((m) => `${m.filename}\0${m.checksumSha256}\0${m.byteLength}\0${m.replay}`).join('\n')).digest('hex');
  return { packageName: 'bailinghub', version, migrations, retiredMigrations, latestMigration: files.at(-1)!, manifestSha256 };
}
function fixture(t: TestContext, version = '0.9.4', retired = false) {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-plan-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  function artifact(name: string, m: Manifest) {
    const dir = join(root, name); mkdirSync(join(dir, 'sql'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bailinghub', version: m.version, scripts: { prestart: `echo ${SECRET}` } }));
    writeFileSync(join(dir, 'config.json'), SECRET); writeFileSync(join(dir, '.env'), SECRET);
    for (const file of m.migrations) writeFileSync(join(dir, 'sql', file.filename), `-- ${file.filename}\n`);
    const path = join(root, `${name}.json`); writeFileSync(path, JSON.stringify(m));
    return { dir, path };
  }
  const from = manifest('0.9.3', ['001_initial.sql', '067_delivery.sql'], retired);
  const to = manifest(version, ['001_initial.sql', '067_delivery.sql', '068_notifications.sql'], retired);
  const a = artifact('from', from); const b = artifact('to', to);
  const snapshot: UpgradeSnapshot = { schema: 'bailing.upgrade-snapshot.v1', captured_at: '2026-01-01T00:00:00Z', source_manifest_sha256: from.manifestSha256,
    state: { backend: 'mysql', database_id: ID }, configuration: { backend: 'mysql', database_id: ID },
    databases: [{ id: ID, ledger_complete: true, checksum_column: 'present', rows: from.migrations.map((m) => ({ filename: m.filename, checksum_sha256: m.checksumSha256 })) }] };
  const snapshotPath = join(root, 'snapshot.json');
  const options: UpgradePlanOptions = { fromArtifact: a.dir, fromManifest: a.path, toArtifact: b.dir, toManifest: b.path, snapshot: snapshotPath };
  function run() { writeFileSync(snapshotPath, JSON.stringify(snapshot)); return runUpgradePlan(options); }
  return { root, from, to, snapshot, options, run };
}
test('official exported manifest digest and SQL inventory are compatible with the planner', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-official-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'official.json'); writeFileSync(path, JSON.stringify(BAILINGHUB_CORE_ARTIFACT_V1));
  const artifact = fileURLToPath(new URL('../', import.meta.url));
  const report = runUpgradePlan({ fromArtifact: artifact, fromManifest: path, toArtifact: artifact, toManifest: path });
  assert.equal(report.from?.manifestSha256, BAILINGHUB_CORE_ARTIFACT_V1.manifestSha256);
  assert.equal(report.to?.manifestSha256, BAILINGHUB_CORE_ARTIFACT_V1.manifestSha256);
  assert.equal(report.result, 'incomplete'); assert.equal(report.exit_code, 2);
});
test('shared MySQL generates one pending plan and honest rollback/scope without reading config', (t) => {
  const f = fixture(t); const report = f.run();
  assert.equal(report.result, 'reviewable'); assert.equal(report.direction, 'upgrade');
  assert.equal(report.databases.length, 1); assert.deepEqual(report.databases[0]?.roles, ['state', 'configuration']);
  assert.deepEqual(report.databases[0]?.pending, ['068_notifications.sql']);
  assert.equal(report.databases[0]?.rollback_after_migration, 'blocked_by_old_manifest');
  assert.equal(report.scope.actual_runtime, 'not_verified'); assert.equal(report.scope.database_connections, false);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});
test('separate configuration database is checked independently and can block the plan', (t) => {
  const f = fixture(t); f.snapshot.configuration.database_id = OTHER;
  f.snapshot.databases.push({ ...f.snapshot.databases[0]!, id: OTHER, rows: [{ filename: '001_initial.sql', checksum_sha256: '0'.repeat(64) }] });
  const report = f.run(); assert.equal(report.snapshot?.topology, 'separate_mysql'); assert.equal(report.databases.length, 2);
  assert.equal(report.result, 'blocked'); assert.deepEqual(report.databases[1]?.hash_conflicts, ['001_initial.sql']);
});
test('missing configuration snapshot is incomplete, never silently treated as shared', (t) => {
  const f = fixture(t); f.snapshot.configuration.database_id = OTHER;
  assert.equal(f.run().result, 'incomplete');
});
test('JSONL state still plans configuration MySQL; files-only explicitly has no SQL', (t) => {
  const f = fixture(t); f.snapshot.state = { backend: 'jsonl', database_id: null };
  let report = f.run(); assert.equal(report.result, 'reviewable'); assert.deepEqual(report.databases[0]?.roles, ['configuration']);
  f.snapshot.configuration = { backend: 'file', database_id: null }; f.snapshot.databases = [];
  report = f.run(); assert.equal(report.snapshot?.topology, 'files_only'); assert.deepEqual(report.databases, []);
});
test('unknown and newer ledger records block rather than being removed or ignored', (t) => {
  const f = fixture(t); f.snapshot.databases[0]!.rows.push({ filename: '999_future.sql', checksum_sha256: null });
  const report = f.run(); assert.equal(report.result, 'blocked'); assert.deepEqual(report.databases[0]?.unknown_migrations, ['999_future.sql']);
});
test('legacy null checksums are incomplete and never backfilled', (t) => {
  const f = fixture(t); f.snapshot.databases[0]!.rows[0]!.checksum_sha256 = null;
  assert.equal(f.run().result, 'incomplete');
  assert.equal(JSON.parse(readFileSync(f.options.snapshot!, 'utf8')).databases[0].rows[0].checksum_sha256, null);
});
test('missing checksum column and partial ledgers are incomplete and cannot produce definitive pending lists', (t) => {
  const f = fixture(t); f.snapshot.databases[0]!.checksum_column = 'absent'; f.snapshot.databases[0]!.rows = [];
  f.snapshot.databases[0]!.ledger_complete = false;
  const report = f.run(); assert.equal(report.result, 'incomplete'); assert.equal(report.databases[0]?.pending, null);
});
test('known retired evidence is accepted but never scheduled for replay', (t) => {
  const f = fixture(t, '0.9.4', true); const retired = f.from.retiredMigrations[0]!;
  f.snapshot.databases[0]!.rows.push({ filename: retired.filename, checksum_sha256: retired.checksumSha256 });
  const report = f.run(); assert.equal(report.result, 'reviewable'); assert.ok(!report.databases[0]?.pending?.includes(retired.filename));
});
function rewriteManifest(path: string, value: Manifest): void {
  const manifestSha256 = createHash('sha256').update('bailinghub-core-artifact-v1').update('\0').update(value.version)
    .update('\0active\0').update(value.migrations.map((m) => `${m.filename}\0${m.checksumSha256}`).join('\n'))
    .update('\0retired\0').update(value.retiredMigrations.map((m) => `${m.filename}\0${m.checksumSha256}\0${m.byteLength}\0${m.replay}`).join('\n')).digest('hex');
  writeFileSync(path, JSON.stringify({ ...value, manifestSha256 }));
}
test('reactivated retired migration is blocked even with matching bytes and recomputed manifest', (t) => {
  const f = fixture(t, '0.9.4', true); const retired = f.from.retiredMigrations[0]!;
  const migrations = [...f.to.migrations, { filename: retired.filename, checksumSha256: retired.checksumSha256 }].sort((a, b) => a.filename.localeCompare(b.filename));
  rewriteManifest(f.options.toManifest!, { ...f.to, migrations, retiredMigrations: [] });
  writeFileSync(join(f.options.toArtifact!, 'sql', retired.filename), 'old bytes');
  const report = f.run(); assert.ok(report.to, 'target is internally self-consistent');
  assert.equal(report.result, 'blocked'); assert.equal(report.exit_code, 1);
  assert.ok(report.checks.some((c) => c.reason === 'target_reactivates_retired_migration'));
  assert.ok(!report.databases[0]?.pending?.includes(retired.filename), 'never recommend replaying retired evidence, even in a blocked report');
});
test('published active migration cannot be silently reclassified as retired', (t) => {
  const f = fixture(t); const active = f.to.migrations.find((m) => m.filename === '067_delivery.sql')!;
  const migrations = f.to.migrations.filter((m) => m.filename !== active.filename);
  rewriteManifest(f.options.toManifest!, { ...f.to, migrations, retiredMigrations: [{ ...active, byteLength: Buffer.byteLength(`-- ${active.filename}\n`), replay: 'never' }] });
  rmSync(join(f.options.toArtifact!, 'sql', active.filename));
  const report = f.run(); assert.ok(report.to, 'target is internally self-consistent'); assert.equal(report.result, 'blocked');
  assert.ok(report.checks.some((c) => c.reason === 'target_reclassifies_published_active_migration'));
});
test('retired byte length changes cannot hide behind unchanged SQL checksum', (t) => {
  const f = fixture(t, '0.9.4', true);
  rewriteManifest(f.options.toManifest!, { ...f.to, retiredMigrations: f.to.retiredMigrations.map((m) => ({ ...m, byteLength: m.byteLength + 1 })) });
  const report = f.run(); assert.ok(report.to, 'target is internally self-consistent'); assert.equal(report.result, 'blocked');
  assert.ok(report.checks.some((c) => c.reason === 'target_changes_retired_migration_evidence'));
});
test('retired evidence must retain replay never', (t) => {
  const f = fixture(t, '0.9.4', true);
  const malformed = { ...f.to, retiredMigrations: f.to.retiredMigrations.map((m) => ({ ...m, replay: 'allowed' })) } as unknown as Manifest;
  rewriteManifest(f.options.toManifest!, malformed);
  const report = f.run(); assert.equal(report.result, 'blocked'); assert.equal(report.to, null);
});
test('source version snapshot mismatch is blocked', (t) => {
  const f = fixture(t); f.snapshot.source_manifest_sha256 = f.to.manifestSha256;
  assert.equal(f.run().result, 'blocked');
});
test('same version different manifest and downgrade are blocked', (t) => {
  for (const version of ['0.9.3', '0.9.2', '0.9.3-rc.1']) { const f = fixture(t, version); assert.equal(f.run().result, 'blocked'); }
});
test('SemVer comparison uses numeric components and prereleases, never prefix matches', () => {
  assert.equal(compareVersions('0.9.10', '0.9.4'), 1); assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1); assert.equal(compareVersions('1.0.0+one', '1.0.0+two'), 0);
});
test('SQL tampering, forged digest, missing inventory, malformed version and duplicate numbers are rejected', (t) => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => writeFileSync(join(f.options.toArtifact!, 'sql/068_notifications.sql'), 'tampered'),
    (f: ReturnType<typeof fixture>) => writeFileSync(f.options.toManifest!, JSON.stringify({ ...f.to, manifestSha256: '0'.repeat(64) })),
    (f: ReturnType<typeof fixture>) => writeFileSync(join(f.options.toArtifact!, 'sql/069_omitted.sql'), '-- unseen'),
    (f: ReturnType<typeof fixture>) => writeFileSync(join(f.options.toArtifact!, 'sql/068_duplicate.sql'), '-- duplicate'),
    (f: ReturnType<typeof fixture>) => writeFileSync(f.options.toManifest!, JSON.stringify({ ...f.to, version: 'v0.9.4' })),
    (f: ReturnType<typeof fixture>) => writeFileSync(f.options.toManifest!, JSON.stringify({ ...f.to, version: '0.9.4-01' })),
  ]) { const f = fixture(t); mutate(f); assert.equal(f.run().result, 'blocked'); }
});
test('manifest traversal paths and symlink SQL files/directories are rejected without exposing content', (t) => {
  for (const kind of ['traversal', 'file', 'directory']) {
    const f = fixture(t);
    if (kind === 'traversal') writeFileSync(f.options.toManifest!, JSON.stringify({ ...f.to, migrations: [{ filename: '../config.json', checksumSha256: sha(SECRET) }] }));
    else if (kind === 'file') { const path = join(f.options.toArtifact!, 'sql/068_notifications.sql'); rmSync(path); symlinkSync(join(f.options.toArtifact!, 'config.json'), path); }
    else { rmSync(join(f.options.toArtifact!, 'sql'), { recursive: true }); symlinkSync(join(f.options.fromArtifact!, 'sql'), join(f.options.toArtifact!, 'sql')); }
    const report = f.run(); assert.equal(report.result, 'blocked'); assert.ok(!JSON.stringify(report).includes(SECRET));
  }
});
test('invalid snapshot fields, duplicate identities and future snapshot are rejected', (t) => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.snapshot.state.database_id = SECRET; },
    (f: ReturnType<typeof fixture>) => { f.snapshot.databases.push(f.snapshot.databases[0]!); },
    (f: ReturnType<typeof fixture>) => { f.snapshot.databases[0]!.rows.push(f.snapshot.databases[0]!.rows[0]!); },
    (f: ReturnType<typeof fixture>) => { f.snapshot.captured_at = '2999-01-01T00:00:00Z'; },
  ]) { const f = fixture(t); mutate(f); const report = f.run(); assert.equal(report.result, 'blocked'); assert.ok(!JSON.stringify(report).includes(SECRET)); }
});
test('recomputed manifest cannot conceal changed published SQL history', (t) => {
  const f = fixture(t);
  const changed = JSON.parse(JSON.stringify(f.to)) as Manifest;
  const migrations = changed.migrations.map((m) => m.filename === '001_initial.sql' ? { ...m, checksumSha256: sha('changed history') } : m);
  const manifestSha256 = createHash('sha256').update('bailinghub-core-artifact-v1').update('\0').update(changed.version)
    .update('\0active\0').update(migrations.map((m) => `${m.filename}\0${m.checksumSha256}`).join('\n')).update('\0retired\0').digest('hex');
  writeFileSync(f.options.toManifest!, JSON.stringify({ ...changed, migrations, manifestSha256 }));
  writeFileSync(join(f.options.toArtifact!, 'sql/001_initial.sql'), 'changed history');
  const report = f.run(); assert.ok(report.to, 'altered target is internally self-consistent');
  assert.equal(report.result, 'blocked');
  assert.ok(report.checks.some((c) => c.reason === 'target_changes_published_migration_checksum'));
});
test('missing source ledger entries are incomplete even when pending SQL is identifiable', (t) => {
  const f = fixture(t); f.snapshot.databases[0]!.rows.pop();
  const report = f.run(); assert.equal(report.result, 'incomplete');
  assert.deepEqual(report.databases[0]?.source_missing, ['067_delivery.sql']);
  assert.deepEqual(report.databases[0]?.pending, ['067_delivery.sql', '068_notifications.sql']);
});
test('a self-consistent synthetic artifact never becomes trusted release or deployment evidence', (t) => {
  const f = fixture(t); const report = f.run(); assert.equal(report.result, 'reviewable');
  assert.equal(report.scope.release_authenticity, 'not_verified');
  assert.equal(report.scope.database_identity, 'snapshot_claim_only');
  assert.equal(report.scope.schema_objects, 'not_checked');
  assert.equal(report.scope.backup_restore, 'not_tested'); assert.equal(report.scope.execution_authorized, false);
});
test('CLI dispatch is read-only, emits clean JSON, and unsupported flags are redacted', (t) => {
  const f = fixture(t); f.run();
  const cli = fileURLToPath(new URL('./doctor.ts', import.meta.url));
  const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const args = ['--import', loader, cli, '--upgrade-plan', '--json'];
  const output = spawnSync(process.execPath, [...args, '--from-artifact', f.options.fromArtifact!, '--from-manifest', f.options.fromManifest!, '--to-artifact', f.options.toArtifact!, '--to-manifest', f.options.toManifest!, '--snapshot', f.options.snapshot!], { cwd: f.root, encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr); assert.equal(JSON.parse(output.stdout).result, 'reviewable'); assert.equal(output.stderr, '');
  const bad = spawnSync(process.execPath, [...args, '--deployment', '--password', SECRET], { cwd: f.root, encoding: 'utf8' });
  assert.equal(bad.status, 64); assert.ok(!`${bad.stdout}${bad.stderr}`.includes(SECRET));
  const missing = spawnSync(process.execPath, args, { cwd: f.root, encoding: 'utf8' }); assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).result, 'incomplete');
});
