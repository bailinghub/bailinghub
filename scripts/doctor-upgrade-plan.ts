import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { assertOfficialMigrationFilenames } from '../src/infrastructure/schema/migration-files';
import type { BailingHubCoreArtifactManifestV1 } from '../src/kernel-api/v1/artifact';

type Manifest = BailingHubCoreArtifactManifestV1;
type Check = { id: string; state: 'pass' | 'fail' | 'unknown'; reason: string };
type Row = { filename: string; checksum_sha256: string | null };
type Database = { id: string; ledger_complete: boolean; checksum_column: 'present' | 'absent'; rows: Row[] };
export interface UpgradeSnapshot {
  schema: 'bailing.upgrade-snapshot.v1';
  captured_at: string;
  source_manifest_sha256: string;
  state: { backend: 'mysql' | 'jsonl'; database_id: string | null };
  configuration: { backend: 'mysql' | 'file'; database_id: string | null };
  databases: Database[];
}
export interface UpgradePlanOptions {
  fromArtifact?: string;
  fromManifest?: string;
  toArtifact?: string;
  toManifest?: string;
  snapshot?: string;
}
export interface UpgradePlanReport {
  schema: 'bailing.upgrade-plan.v1';
  mode: 'offline';
  result: 'reviewable' | 'blocked' | 'incomplete';
  exit_code: 0 | 1 | 2;
  basis: 'supplied_local_artifacts_and_snapshot';
  from: Manifest | null;
  to: Manifest | null;
  direction: 'upgrade' | 'same_version' | 'downgrade' | 'unknown';
  snapshot: { captured_at: string; sha256: string; topology: 'shared_mysql' | 'separate_mysql' | 'mixed' | 'files_only' } | null;
  databases: { id: string; roles: string[]; pending: string[] | null; missing_checksums: string[]; hash_conflicts: string[]; unknown_migrations: string[]; source_missing: string[] | null; rollback_after_migration: 'blocked_by_old_manifest' | 'requires_validation' | 'unknown' }[];
  checks: Check[];
  actions: { id: string; detail: string }[];
  scope: { network: false; subprocesses: false; config_credentials_read: false; database_connections: false; mutations: false; release_authenticity: 'not_verified'; actual_runtime: 'not_verified'; database_identity: 'snapshot_claim_only'; schema_objects: 'not_checked'; backup_restore: 'not_tested'; execution_authorized: false };
}
const HEX = /^[a-f0-9]{64}$/;
const FILENAME = /^\d{3}_[a-z0-9][a-z0-9_-]*\.sql$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_JSON = 4 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_object');
  return value as Record<string, unknown>;
}
function digest(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function read(file: string, maximum = MAX_JSON): Buffer {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error('invalid_input_file');
  return readFileSync(file);
}
// Paths inside an artifact are fixed, and symlinked files/directories are rejected.
// Never import or execute code from an operator-supplied artifact.
function artifactFile(root: string, file: string, maximum = MAX_JSON): Buffer {
  const canonical = realpathSync(root);
  let current = canonical;
  for (const part of file.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('artifact_symlink');
  }
  const delta = relative(canonical, realpathSync(current));
  if (delta.startsWith('..') || isAbsolute(delta)) throw new Error('artifact_path_escape');
  return read(current, maximum);
}
function validVersion(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 80) return false;
  const match = SEMVER.exec(value);
  return !!match && !(match[4]?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0'));
}
export function compareVersions(left: string, right: string): number {
  const a = SEMVER.exec(left)!;
  const b = SEMVER.exec(right)!;
  for (let i = 1; i <= 3; i++) {
    if (BigInt(a[i]!) !== BigInt(b[i]!)) return BigInt(a[i]!) > BigInt(b[i]!) ? 1 : -1;
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const ap = a[4].split('.'); const bp = b[4].split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i]; const y = bp[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
// This is the v1 manifest digest format from kernel-api/v1/artifact.ts. The
// official exported manifest is the input; no locally assumed retired list.
function manifestDigest(manifest: Manifest): string {
  return createHash('sha256').update('bailinghub-core-artifact-v1').update('\0').update(manifest.version)
    .update('\0active\0').update(manifest.migrations.map((m) => `${m.filename}\0${m.checksumSha256}`).join('\n'))
    .update('\0retired\0').update(manifest.retiredMigrations.map((m) => `${m.filename}\0${m.checksumSha256}\0${m.byteLength}\0${m.replay}`).join('\n')).digest('hex');
}
function readManifest(root: string, manifestPath: string): Manifest {
  const input = object(JSON.parse(read(manifestPath).toString('utf8')));
  if (input.packageName !== 'bailinghub' || !validVersion(input.version) || typeof input.manifestSha256 !== 'string' || !HEX.test(input.manifestSha256)) throw new Error('invalid_manifest');
  if (!Array.isArray(input.migrations) || !input.migrations.length || input.migrations.length > 1000 || !Array.isArray(input.retiredMigrations) || input.retiredMigrations.length > 1000) throw new Error('invalid_manifest');
  const migrations = input.migrations.map((value) => {
    const m = object(value);
    if (typeof m.filename !== 'string' || !FILENAME.test(m.filename) || typeof m.checksumSha256 !== 'string' || !HEX.test(m.checksumSha256)) throw new Error('invalid_migration');
    return { filename: m.filename, checksumSha256: m.checksumSha256 };
  });
  assertOfficialMigrationFilenames(migrations.map((m) => m.filename));
  const retiredMigrations = input.retiredMigrations.map((value) => {
    const m = object(value);
    if (typeof m.filename !== 'string' || !FILENAME.test(m.filename) || typeof m.checksumSha256 !== 'string' || !HEX.test(m.checksumSha256) || typeof m.byteLength !== 'number' || !Number.isSafeInteger(m.byteLength) || m.byteLength < 0 || m.replay !== 'never') throw new Error('invalid_retired_migration');
    return { filename: m.filename, checksumSha256: m.checksumSha256, byteLength: m.byteLength, replay: 'never' as const };
  });
  const names = migrations.map((m) => m.filename);
  if (names.join('\n') !== [...names].sort().join('\n') || new Set([...names, ...retiredMigrations.map((m) => m.filename)]).size !== migrations.length + retiredMigrations.length || input.latestMigration !== names.at(-1)) throw new Error('invalid_manifest_order');
  const manifest: Manifest = { packageName: 'bailinghub', version: input.version, migrations, retiredMigrations, latestMigration: names.at(-1)!, manifestSha256: input.manifestSha256 };
  if (manifestDigest(manifest) !== manifest.manifestSha256) throw new Error('manifest_digest_mismatch');
  const pkg = object(JSON.parse(artifactFile(root, 'package.json').toString('utf8')));
  if (pkg.name !== manifest.packageName || pkg.version !== manifest.version) throw new Error('artifact_package_mismatch');
  // Validate all SQL filenames, including files omitted from the supplied manifest.
  artifactFile(root, `sql/${names[0]}`, 16 * 1024 * 1024);
  const sqlNames = readdirSync(join(realpathSync(root), 'sql')).filter((file) => file.endsWith('.sql')).sort();
  assertOfficialMigrationFilenames(sqlNames);
  if (sqlNames.join('\n') !== names.join('\n')) throw new Error('artifact_sql_inventory_mismatch');
  for (const m of migrations) if (digest(artifactFile(root, `sql/${m.filename}`, 16 * 1024 * 1024)) !== m.checksumSha256) throw new Error('artifact_sql_digest_mismatch');
  return manifest;
}
function readSnapshot(path: string): { snapshot: UpgradeSnapshot; sha256: string } {
  const bytes = read(path); const value = object(JSON.parse(bytes.toString('utf8')));
  if (value.schema !== 'bailing.upgrade-snapshot.v1' || typeof value.captured_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.captured_at) || !Number.isFinite(Date.parse(value.captured_at)) || typeof value.source_manifest_sha256 !== 'string' || !HEX.test(value.source_manifest_sha256)) throw new Error('invalid_snapshot');
  const state = object(value.state); const configuration = object(value.configuration);
  if (!['mysql', 'jsonl'].includes(String(state.backend)) || !['mysql', 'file'].includes(String(configuration.backend))) throw new Error('unsupported_backend');
  for (const role of [state, configuration]) {
    if (role.backend === 'mysql' ? typeof role.database_id !== 'string' || !HEX.test(role.database_id) : role.database_id !== null) throw new Error('invalid_database_identity');
  }
  if (!Array.isArray(value.databases) || value.databases.length > 2) throw new Error('invalid_databases');
  const databases = value.databases.map((entry): Database => {
    const db = object(entry);
    if (typeof db.id !== 'string' || !HEX.test(db.id) || typeof db.ledger_complete !== 'boolean' || !['present', 'absent'].includes(String(db.checksum_column)) || !Array.isArray(db.rows) || db.rows.length > 2000) throw new Error('invalid_database');
    const rows = db.rows.map((entry): Row => {
      const row = object(entry);
      if (typeof row.filename !== 'string' || !FILENAME.test(row.filename) || (row.checksum_sha256 !== null && (typeof row.checksum_sha256 !== 'string' || !HEX.test(row.checksum_sha256)))) throw new Error('invalid_ledger_row');
      return { filename: row.filename, checksum_sha256: row.checksum_sha256 as string | null };
    });
    if (new Set(rows.map((r) => r.filename)).size !== rows.length || (db.checksum_column === 'absent' && rows.some((r) => r.checksum_sha256 !== null))) throw new Error('contradictory_ledger');
    return { id: db.id, ledger_complete: db.ledger_complete, checksum_column: db.checksum_column as Database['checksum_column'], rows };
  });
  if (new Set(databases.map((d) => d.id)).size !== databases.length) throw new Error('duplicate_database');
  // Never retain unknown fields (which may contain accidental credentials).
  return { sha256: digest(bytes), snapshot: { schema: 'bailing.upgrade-snapshot.v1', captured_at: value.captured_at, source_manifest_sha256: value.source_manifest_sha256,
    state: { backend: state.backend as 'mysql' | 'jsonl', database_id: state.database_id as string | null },
    configuration: { backend: configuration.backend as 'mysql' | 'file', database_id: configuration.database_id as string | null }, databases } };
}
function known(manifest: Manifest): Map<string, string> { return new Map([...manifest.migrations, ...manifest.retiredMigrations].map((m) => [m.filename, m.checksumSha256])); }
export function runUpgradePlan(options: UpgradePlanOptions): UpgradePlanReport {
  const report: UpgradePlanReport = {
    schema: 'bailing.upgrade-plan.v1', mode: 'offline', result: 'incomplete', exit_code: 2, basis: 'supplied_local_artifacts_and_snapshot', from: null, to: null, direction: 'unknown', snapshot: null, databases: [], checks: [],
    scope: { network: false, subprocesses: false, config_credentials_read: false, database_connections: false, mutations: false, release_authenticity: 'not_verified', actual_runtime: 'not_verified', database_identity: 'snapshot_claim_only', schema_objects: 'not_checked', backup_restore: 'not_tested', execution_authorized: false },
    actions: [
      { id: 'identity', detail: 'Confirm official tag/commit/package or image digest and that the source artifact and effective state/configuration stores match the running deployment. An offline manifest covers version and SQL, not whole-artifact authenticity.' },
      { id: 'backup', detail: 'Retain the source artifact and a consistent restore set: state/configuration databases, migration ledgers, config/secrets, JSONL, attachments and other runtime data. Test restore in isolation; do not include credentials or business payloads in this report.' },
      { id: 'drain', detail: 'Stop new intake and all writers sharing these stores; drain every replica and accepted background work. Reconcile approvals, pending/unknown business effects, notification outbox and DLQ receipts; keep original IDs.' },
      { id: 'migrate', detail: 'After reviewing the version-specific upgrade guide, use only the target official migrator, once per distinct MySQL database, never concurrently. npm run db:init covers state.mysql only; a separate configuration MySQL needs migrateBailingHubCoreSchema({mysql: configurationDatabase}). JSONL/file stores have no SQL migration.' },
      { id: 'acceptance', detail: 'After manual migration, collect fresh ledgers; verify actual tables/indexes, readiness and isolated permission/approval/recovery/notification flows before reopening traffic. This plan runs none of these checks.' },
      { id: 'rollback', detail: 'Do not delete ledger rows, replay retired migrations or assume switching the old tag is safe. New records may be rejected by the old manifest or ignored by old workers. Restore a tested consistent set and reconcile later external refunds/messages; DB restore cannot undo external effects.' },
    ],
  };
  const add = (id: string, state: Check['state'], reason: string) => report.checks.push({ id, state, reason });
  for (const side of ['from', 'to'] as const) {
    const root = side === 'from' ? options.fromArtifact : options.toArtifact;
    const path = side === 'from' ? options.fromManifest : options.toManifest;
    if (!root || !path) { add(`${side}.artifact`, 'unknown', 'explicit_artifact_directory_and_manifest_required'); continue; }
    try { report[side] = readManifest(root, path); add(`${side}.artifact`, 'pass', 'local_package_sql_and_manifest_match'); }
    catch { add(`${side}.artifact`, 'fail', 'artifact_or_manifest_unreadable_invalid_or_mismatched'); }
  }
  const from = report.from; const to = report.to;
  if (from && to) {
    const cmp = compareVersions(to.version, from.version);
    report.direction = cmp < 0 ? 'downgrade' : cmp > 0 ? 'upgrade' : 'same_version';
    add('version.direction', cmp < 0 ? 'fail' : 'pass', cmp < 0 ? 'downgrade_requires_separate_restore_procedure' : report.direction);
    if (!cmp && from.manifestSha256 !== to.manifestSha256) add('version.identity', 'fail', 'same_version_has_different_manifest');
    const targetKnown = known(to);
    const targetActive = new Set(to.migrations.map((m) => m.filename));
    const targetRetired = new Map(to.retiredMigrations.map((m) => [m.filename, m]));
    // Retirement is not a reversible classification. Never put evidence-only
    // SQL back in the replayable sequence, even when its bytes still match.
    for (const m of from.retiredMigrations) {
      if (targetActive.has(m.filename)) add('migration.history', 'fail', 'target_reactivates_retired_migration');
      const retired = targetRetired.get(m.filename);
      if (retired && (retired.byteLength !== m.byteLength || retired.replay !== m.replay)) {
        add('migration.history', 'fail', 'target_changes_retired_migration_evidence');
      }
    }
    for (const m of from.migrations) {
      if (targetRetired.has(m.filename)) add('migration.history', 'fail', 'target_reclassifies_published_active_migration');
    }
    for (const m of [...from.migrations, ...from.retiredMigrations]) {
      if (!targetKnown.has(m.filename)) add('migration.history', 'fail', 'target_drops_known_migration_evidence');
      else if (targetKnown.get(m.filename) !== m.checksumSha256) add('migration.history', 'fail', 'target_changes_published_migration_checksum');
    }
  }
  if (!options.snapshot) add('snapshot', 'unknown', 'explicit_sanitized_snapshot_required');
  else {
    try {
      const { snapshot, sha256 } = readSnapshot(options.snapshot);
      const roles = [snapshot.state, snapshot.configuration];
      const required = [...new Set(roles.flatMap((r) => r.database_id ? [r.database_id] : []))];
      const topology = required.length === 2 ? 'separate_mysql' : required.length === 0 ? 'files_only' : roles.every((r) => r.backend === 'mysql') ? 'shared_mysql' : 'mixed';
      report.snapshot = { captured_at: snapshot.captured_at, sha256, topology };
      add('snapshot.binding', !from ? 'unknown' : from.manifestSha256 === snapshot.source_manifest_sha256 ? 'pass' : 'fail', !from ? 'source_manifest_unavailable' : from.manifestSha256 === snapshot.source_manifest_sha256 ? 'supplied_snapshot_claim_matches_source_manifest' : 'snapshot_source_manifest_mismatch');
      add('snapshot.topology', required.every((id) => snapshot.databases.some((d) => d.id === id)) && snapshot.databases.every((d) => required.includes(d.id)) ? 'pass' : 'unknown', 'database_roles_require_exact_snapshot_coverage');
      if (Date.parse(snapshot.captured_at) > Date.now() + 300_000) add('snapshot.time', 'fail', 'snapshot_timestamp_is_in_the_future');
      // Age cannot establish freshness: the operator must recollect after any change.
      for (const db of snapshot.databases.filter((d) => required.includes(d.id))) {
        const dbRoles = [snapshot.state.database_id === db.id ? 'state' : '', snapshot.configuration.database_id === db.id ? 'configuration' : ''].filter(Boolean);
        add(`database.${dbRoles.join('+')}.completeness`, db.ledger_complete ? 'pass' : 'unknown', db.ledger_complete ? 'operator_asserted_complete_ledger_snapshot' : 'partial_ledger_cannot_determine_pending');
        if (!to || !from) continue;
        const rows = new Map(db.rows.map((r) => [r.filename, r.checksum_sha256])); const targetKnown = known(to); const sourceKnown = known(from);
        const pending = to.migrations.filter((m) => !rows.has(m.filename) && !from.retiredMigrations.some((retired) => retired.filename === m.filename)).map((m) => m.filename);
        const missing = db.rows.filter((r) => r.checksum_sha256 === null).map((r) => r.filename);
        const conflicts = db.rows.filter((r) => r.checksum_sha256 !== null && targetKnown.has(r.filename) && targetKnown.get(r.filename) !== r.checksum_sha256).map((r) => r.filename);
        const unknown = db.rows.filter((r) => !targetKnown.has(r.filename) || !sourceKnown.has(r.filename)).map((r) => r.filename);
        const sourceMissing = from.migrations.filter((m) => !rows.has(m.filename)).map((m) => m.filename);
        report.databases.push({ id: db.id, roles: dbRoles, pending: db.ledger_complete ? pending : null, missing_checksums: missing, hash_conflicts: conflicts, unknown_migrations: unknown, source_missing: db.ledger_complete ? sourceMissing : null, rollback_after_migration: !db.ledger_complete ? 'unknown' : pending.some((name) => !sourceKnown.has(name)) ? 'blocked_by_old_manifest' : 'requires_validation' });
        if (unknown.length) add(`database.${dbRoles.join('+')}.ledger.known`, 'fail', 'ledger_contains_migration_unknown_to_source_or_target');
        if (conflicts.length) add(`database.${dbRoles.join('+')}.ledger.checksums`, 'fail', 'ledger_checksum_conflict');
        if (missing.length || db.checksum_column === 'absent') add(`database.${dbRoles.join('+')}.ledger.checksums`, 'unknown', 'legacy_checksums_missing_no_backfill_performed');
        if (db.ledger_complete && sourceMissing.length) add(`database.${dbRoles.join('+')}.ledger.source`, 'unknown', 'source_migrations_missing_in_claimed_current_database');
      }
    } catch { add('snapshot', 'fail', 'snapshot_unreadable_invalid_or_contradictory'); }
  }
  if (report.checks.some((c) => c.state === 'fail')) { report.result = 'blocked'; report.exit_code = 1; }
  else if (report.checks.some((c) => c.state === 'unknown')) { report.result = 'incomplete'; report.exit_code = 2; }
  else { report.result = 'reviewable'; report.exit_code = 0; }
  return report;
}
export const UPGRADE_PLAN_USAGE = `BailingHub offline, read-only upgrade plan
Usage: npm run --silent doctor -- --upgrade-plan --from-artifact <dir> --from-manifest <json> --to-artifact <dir> --to-manifest <json> --snapshot <json> --json
Options: --from-artifact, --from-manifest, --to-artifact, --to-manifest, --snapshot,
         --json, --help. Paths are explicit; no defaults or environment discovery.
Manifests: export BAILINGHUB_CORE_ARTIFACT_V1 from each trusted artifact (see docs/UPGRADE_PLAN.md).
Exit: 0 reviewable offline comparison, NOT deployment readiness; 1 blocked/mismatched;
      2 incomplete/missing evidence; 64 invalid arguments.
No network, subprocesses, config/credential loading, DB connection, migration, write,
backup, restore, automatic upgrade or execution approval. Snapshot facts are supplied,
not live verified. Review version-specific guides and recollect after changes.
`;
export function runUpgradePlanCli(args: string[], cwd: string): number {
  let json = false; let invalid = false;
  const options: UpgradePlanOptions = {};
  const flags: Record<string, keyof UpgradePlanOptions> = { '--from-artifact': 'fromArtifact', '--from-manifest': 'fromManifest', '--to-artifact': 'toArtifact', '--to-manifest': 'toManifest', '--snapshot': 'snapshot' };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--upgrade-plan') continue;
    if (arg === '--help') { console.log(UPGRADE_PLAN_USAGE); return 0; }
    if (arg === '--json') { json = true; continue; }
    const key = flags[arg]; const value = args[i + 1];
    if (!key || !value || value.startsWith('--') || seen.has(arg)) { invalid = true; continue; }
    options[key] = resolve(cwd, value); seen.add(arg); i++;
  }
  if (invalid) {
    console.log(json ? JSON.stringify({ schema: 'bailing.upgrade-plan.v1', result: 'invalid_arguments', exit_code: 64, reason: 'invalid_or_unsupported_argument' }) : 'Invalid upgrade plan arguments. Use --upgrade-plan --help.');
    return 64;
  }
  const report = runUpgradePlan(options);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`BailingHub offline upgrade plan: ${report.result} (${report.from?.version ?? '?'} -> ${report.to?.version ?? '?'})`);
    for (const check of report.checks) console.log(`${check.state} ${check.id}: ${check.reason}`);
    for (const db of report.databases) console.log(`${db.roles.join('+')}: pending=${db.pending?.length ?? 'unknown'}, missing_checksums=${db.missing_checksums.length}, conflicts=${db.hash_conflicts.length}, unknown=${db.unknown_migrations.length}`);
    for (const action of report.actions) console.log(`${action.id}: ${action.detail}`);
    console.log('Offline evidence only; runtime, database identity, schema objects, authenticity and restoration are not verified. Use --json for full inventory.');
  }
  return report.exit_code;
}
