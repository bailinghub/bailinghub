import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

type IdentityState = 'verified' | 'unknown' | 'not_checked' | 'mismatch';
type CheckState = 'pass' | 'fail' | 'unknown' | 'not_checked';
type JsonObject = Record<string, unknown>;
type Check = { id: string; state: CheckState; reason: string; http_status?: number };
type Artifact = { version: string | null; commit: string | null; latest_migration: string | null; migration_count: number | null };

export interface DeploymentDoctorOptions {
  root: string;
  url?: string;
  readiness?: boolean;
  expectedVersion?: string;
  expectedCommit?: string;
  timeoutMs?: number;
}

export interface DeploymentDoctorReport {
  schema: 'bailing.deployment-diagnostics.v1';
  checked_at: string;
  mode: 'deployment';
  result: 'pass' | 'fail' | 'incomplete';
  exit_code: 0 | 1 | 2;
  target: { origin: string; base_path: 'root' | 'configured_not_printed' } | null;
  source: Artifact & { state: IdentityState; commit_basis: 'git_head' | 'build_info' | 'unavailable'; worktree: 'clean' | 'dirty' | 'not_checked'; basis: 'local_metadata'; artifact_integrity: 'not_checked' };
  runtime: Artifact & { state: IdentityState; paused: boolean | null; backend: 'mysql' | 'jsonl' | null; basis: 'reported_metadata'; artifact_integrity: 'not_checked' };
  comparison: { state: IdentityState; expected_version: string | null; expected_commit: string | null; basis: 'local_source' | 'explicit_expectation'; version_matches: boolean | null; commit_matches: boolean | null };
  configuration: { state: 'unknown'; reason: 'effective_configuration_not_read'; local_files: { config_json: string; dotenv: string }; credentials: 'not_checked' };
  database: { state: 'not_checked'; reason: 'no_direct_database_connection' };
  migrations: { identity: { state: 'not_checked'; reason: 'authenticated_migration_ledger_not_requested' }; readiness: { state: IdentityState; pending: number | null; reason: string } };
  protected_endpoints: { state: 'not_checked'; reason: 'no_credentials_or_login'; paths: readonly ['/admin/api/version', '/admin/api/status'] };
  upgrade: { state: 'not_checked'; reason: 'diagnostics_do_not_authorize_upgrade_or_rollback' };
  checks: Check[];
  scope: { methods: readonly ['GET']; paths: string[]; timeout_ms_per_request: number; max_response_bytes: number; redirects: 'rejected'; model_calls: false; mutations: false };
}

const MAX_BYTES = 64 * 1024;
const PUBLIC_PATHS = ['/health', '/version', '/health/ready'] as const;
const DEFAULT_TIMEOUT = 5000;
const EMPTY_ARTIFACT: Artifact = { version: null, commit: null, latest_migration: null, migration_count: null };

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function version(value: unknown): string | null {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) && value.length <= 80 ? value : null;
}

function commit(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{12,64}$/i.test(value) ? value.toLowerCase() : null;
}

function migration(value: unknown): string | null {
  return typeof value === 'string' && /^\d{3}_[a-z0-9_]+\.sql$/.test(value) && value.length <= 160 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readJson(file: string): JsonObject | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return object(JSON.parse(readFileSync(file, 'utf8')));
  } catch { return null; }
}

function presence(file: string): 'present' | 'absent' | 'unreadable' {
  try { return statSync(file).isFile() ? 'present' : 'unreadable'; }
  catch (error) { return object(error)?.code === 'ENOENT' ? 'absent' : 'unreadable'; }
}

function sourceIdentity(root: string): DeploymentDoctorReport['source'] {
  const pkg = readJson(join(root, 'package.json'));
  let gitCommit: string | null = null;
  let worktree: DeploymentDoctorReport['source']['worktree'] = 'not_checked';
  // These are the only subprocesses in deployment mode: Git reads checkout
  // identity and dirtiness. No package scripts, config loader or DB drivers.
  try {
    statSync(join(root, '.git'));
    const env = { ...process.env };
    // Ambient Git overrides must not select a different repository or index.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
    const gitOptions = {
      cwd: root, env, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'], timeout: 1000, maxBuffer: 1024 * 1024,
    };
    gitCommit = commit(execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD'], {
      ...gitOptions, maxBuffer: 4096,
    }).trim());
    // Only emit clean/dirty, never filenames or contents. Disable fsmonitor
    // hooks and optional index writes for the read-only command.
    worktree = execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'], gitOptions).trim() ? 'dirty' : 'clean';
  } catch { /* Source archives may have only build-info.json. */ }
  const buildCommit = commit(object(readJson(join(root, 'build-info.json'))?.build)?.commit);
  let files: string[] | null = null;
  try { files = readdirSync(join(root, 'sql')).filter((file) => migration(file) !== null).sort(); }
  catch { /* Missing packaged SQL is unknown, not a database failure. */ }
  return {
    state: pkg?.name === 'bailinghub' && version(pkg.version) && (gitCommit ?? buildCommit) ? 'verified' : 'unknown',
    version: pkg?.name === 'bailinghub' ? version(pkg.version) : null,
    commit: gitCommit ?? buildCommit,
    commit_basis: gitCommit ? 'git_head' : buildCommit ? 'build_info' : 'unavailable',
    worktree, basis: 'local_metadata', artifact_integrity: 'not_checked',
    latest_migration: files?.at(-1) ?? null,
    migration_count: files?.length ?? null,
  };
}

function targetUrl(input: string): URL | null {
  try {
    const url = new URL(input);
    // Refuse credentials rather than silently converting an authenticated URL
    // into a request. Never echo an input URL or an invalid argument.
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (!/^\/(?:[a-zA-Z0-9._~-]+\/)*[a-zA-Z0-9._~-]*$/.test(url.pathname)) return null;
    if (url.pathname.split('/').some((part) => part === '.' || part === '..')) return null;
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url;
  } catch { return null; }
}

type Probe = { state: CheckState; reason: string; http_status?: number; body?: JsonObject };

async function probe(target: URL, path: typeof PUBLIC_PATHS[number], timeoutMs: number): Promise<Probe> {
  if (!PUBLIC_PATHS.includes(path)) throw new Error('unsupported_diagnostic_path');
  const url = new URL(target.href);
  url.pathname = `${target.pathname.replace(/\/+$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET', headers: { accept: 'application/json' }, credentials: 'omit',
      redirect: 'manual', signal: controller.signal,
    });
    const http_status = response.status;
    if (http_status >= 300 && http_status < 400) {
      controller.abort();
      return { state: 'fail', reason: 'redirect_rejected', http_status };
    }
    if (http_status === 401 || http_status === 403) {
      controller.abort();
      return { state: 'not_checked', reason: 'authentication_required', http_status };
    }
    if (http_status !== 200 && !(path === '/health/ready' && http_status === 503)) {
      controller.abort();
      return { state: 'fail', reason: 'unexpected_http_status', http_status };
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json' && !/^application\/[a-z0-9.-]+\+json$/.test(contentType ?? '')) {
      controller.abort();
      return { state: 'fail', reason: 'unexpected_content_type', http_status };
    }
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > MAX_BYTES) {
      controller.abort();
      return { state: 'fail', reason: 'response_too_large', http_status };
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_BYTES) {
          controller.abort();
          return { state: 'fail', reason: 'response_too_large', http_status };
        }
        chunks.push(next.value);
      }
    }
    let body: JsonObject | null;
    try { body = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { return { state: 'fail', reason: 'invalid_json', http_status }; }
    if (!body) return { state: 'fail', reason: 'invalid_json_object', http_status };
    return { state: 'pass', reason: 'response_received', http_status, body };
  } catch {
    return { state: 'fail', reason: controller.signal.aborted ? 'request_timeout' : 'unreachable' };
  } finally { clearTimeout(timer); }
}

function identity(body: JsonObject | undefined): Artifact {
  const app = object(body?.app);
  const migrations = object(body?.migrations);
  return {
    version: app?.name === 'bailinghub' ? version(app.version) : null,
    commit: commit(object(body?.build)?.commit),
    latest_migration: migration(migrations?.latest),
    migration_count: count(migrations?.total),
  };
}

function sameCommit(a: string | null, b: string | null): boolean | null {
  return a && b ? a.startsWith(b) || b.startsWith(a) : null;
}

function addProbe(checks: Check[], id: string, result: Probe): void {
  checks.push({ id, state: result.state, reason: result.reason, ...(result.http_status ? { http_status: result.http_status } : {}) });
}

export async function runDeploymentDoctor(options: DeploymentDoctorOptions): Promise<DeploymentDoctorReport> {
  const source = sourceIdentity(options.root);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const report: DeploymentDoctorReport = {
    schema: 'bailing.deployment-diagnostics.v1', checked_at: new Date().toISOString(), mode: 'deployment',
    result: 'incomplete', exit_code: 2, target: null, source,
    runtime: { ...EMPTY_ARTIFACT, state: 'not_checked', paused: null, backend: null, basis: 'reported_metadata', artifact_integrity: 'not_checked' },
    comparison: {
      state: 'not_checked', expected_version: options.expectedVersion === undefined ? source.version : version(options.expectedVersion),
      expected_commit: options.expectedCommit === undefined ? source.commit : commit(options.expectedCommit),
      basis: options.expectedVersion || options.expectedCommit ? 'explicit_expectation' : 'local_source',
      version_matches: null, commit_matches: null,
    },
    configuration: { state: 'unknown', reason: 'effective_configuration_not_read', local_files: {
      config_json: presence(join(options.root, 'config.json')), dotenv: presence(join(options.root, '.env')),
    }, credentials: 'not_checked' },
    database: { state: 'not_checked', reason: 'no_direct_database_connection' },
    migrations: { identity: { state: 'not_checked', reason: 'authenticated_migration_ledger_not_requested' },
      readiness: { state: 'not_checked', pending: null, reason: 'readiness_not_requested' } },
    protected_endpoints: { state: 'not_checked', reason: 'no_credentials_or_login', paths: ['/admin/api/version', '/admin/api/status'] },
    upgrade: { state: 'not_checked', reason: 'diagnostics_do_not_authorize_upgrade_or_rollback' },
    checks: [], scope: { methods: ['GET'], paths: [], timeout_ms_per_request: timeoutMs, max_response_bytes: MAX_BYTES,
      redirects: 'rejected', model_calls: false, mutations: false },
  };
  report.checks.push({ id: 'source.package', state: source.version ? 'pass' : 'unknown', reason: source.version ? 'local_package_identity_read' : 'local_package_identity_unavailable' });
  report.checks.push({ id: 'source.commit', state: source.commit ? 'pass' : 'unknown', reason: source.commit ? 'local_git_or_build_commit_read' : 'local_commit_unavailable' });
  const target = options.url ? targetUrl(options.url) : null;
  if (!options.url) report.checks.push({ id: 'target', state: 'not_checked', reason: 'explicit_url_required' });
  else if (!target) report.checks.push({ id: 'target', state: 'fail', reason: 'invalid_or_credential_bearing_url' });
  else if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000
    || (options.expectedVersion !== undefined && !version(options.expectedVersion))
    || (options.expectedCommit !== undefined && !commit(options.expectedCommit))) {
    // Library callers receive the same redacted failure as the CLI. Never
    // send a request using invalid options or echo an invalid expectation.
    report.comparison.expected_version = version(report.comparison.expected_version);
    report.comparison.expected_commit = commit(report.comparison.expected_commit);
    report.checks.push({ id: 'options', state: 'fail', reason: 'invalid_diagnostic_options' });
  } else {
    report.target = { origin: target.origin, base_path: target.pathname === '/' ? 'root' : 'configured_not_printed' };
    report.scope.paths = options.readiness ? [...PUBLIC_PATHS] : ['/health', '/version'];
    const health = await probe(target, '/health', timeoutMs);
    const runtimeVersion = await probe(target, '/version', timeoutMs);
    addProbe(report.checks, 'http.health', health);
    addProbe(report.checks, 'http.version', runtimeVersion);
    if (health.body && health.body.status !== 'ok') report.checks.push({ id: 'runtime.health', state: 'fail', reason: 'health_status_not_ok' });
    const observed = identity(runtimeVersion.body);
    const healthIdentity = identity(health.body);
    report.runtime = { ...observed, state: observed.version && observed.commit ? 'verified' : 'unknown',
      paused: typeof health.body?.paused === 'boolean' ? health.body.paused : null,
      backend: health.body?.backend === 'mysql' || health.body?.backend === 'jsonl' ? health.body.backend : null,
      basis: 'reported_metadata', artifact_integrity: 'not_checked' };
    if (!observed.version || !observed.commit) report.checks.push({ id: 'runtime.identity', state: 'unknown', reason: 'public_version_or_commit_unavailable' });
    if ([health.body, runtimeVersion.body].some((body) => typeof object(body?.app)?.name === 'string' && object(body?.app)?.name !== 'bailinghub')) {
      report.runtime.state = 'mismatch';
      report.checks.push({ id: 'runtime.application', state: 'fail', reason: 'unexpected_application_identity' });
    }
    if (healthIdentity.version && observed.version && (healthIdentity.version !== observed.version || sameCommit(healthIdentity.commit, observed.commit) === false)) {
      report.runtime.state = 'mismatch';
      report.checks.push({ id: 'runtime.consistency', state: 'fail', reason: 'health_version_identity_mismatch' });
    }
    const comparison = report.comparison;
    comparison.version_matches = comparison.expected_version && observed.version ? comparison.expected_version === observed.version : null;
    comparison.commit_matches = sameCommit(comparison.expected_commit, observed.commit);
    comparison.state = comparison.version_matches === false || comparison.commit_matches === false ? 'mismatch'
      : comparison.version_matches === true && comparison.commit_matches === true ? 'verified' : 'unknown';
    const dirtySource = source.worktree === 'dirty' && comparison.basis === 'local_source';
    const unavailableWorktree = source.commit_basis === 'git_head' && source.worktree === 'not_checked' && comparison.basis === 'local_source';
    if ((dirtySource || unavailableWorktree) && comparison.state === 'verified') comparison.state = 'unknown';
    report.checks.push({ id: 'artifact.comparison', state: comparison.state === 'verified' ? 'pass' : comparison.state === 'mismatch' ? 'fail' : 'unknown',
      reason: comparison.state === 'verified' ? 'reported_identity_matches_expectation' : comparison.state === 'mismatch' ? 'reported_identity_mismatch' : dirtySource ? 'local_worktree_modified' : unavailableWorktree ? 'local_worktree_unavailable' : 'version_or_commit_unavailable' });
    const migrationMatches = source.latest_migration && observed.latest_migration ? source.latest_migration === observed.latest_migration : null;
    report.checks.push({ id: 'artifact.migrations', state: comparison.basis === 'explicit_expectation' ? 'not_checked'
      : migrationMatches === null || source.migration_count === null || observed.migration_count === null ? 'unknown'
      : migrationMatches && source.migration_count === observed.migration_count ? 'pass' : 'fail',
      reason: comparison.basis === 'explicit_expectation' ? 'different_source_comparison_not_requested' : migrationMatches === null || source.migration_count === null || observed.migration_count === null ? 'packaged_migration_list_unavailable' : 'packaged_migrations_compared_not_applied_ledger' });
    if (options.readiness) {
      const ready = await probe(target, '/health/ready', timeoutMs);
      addProbe(report.checks, 'http.readiness', ready);
      const checks = object(ready.body?.checks);
      const migrations = object(checks?.migrations);
      report.migrations.readiness.pending = count(migrations?.pending);
      if (ready.body?.status === 'not_ready' || migrations?.status === 'pending' || migrations?.status === 'failed' || checks?.database === 'failed') {
        report.migrations.readiness.state = 'mismatch';
        report.migrations.readiness.reason = 'server_reports_not_ready';
        report.checks.push({ id: 'runtime.readiness', state: 'fail', reason: 'server_reports_not_ready' });
      } else if (ready.http_status === 200 && ready.body?.status === 'ready' && checks?.database === 'ok' && migrations?.status === 'ok' && migrations.pending === 0) {
        report.migrations.readiness = { state: 'verified', pending: 0, reason: 'server_readiness_summary_only' };
        report.checks.push({ id: 'runtime.readiness', state: 'pass', reason: 'server_readiness_summary_only' });
      } else {
        report.migrations.readiness.state = ready.state === 'not_checked' ? 'not_checked' : 'unknown';
        report.migrations.readiness.reason = ready.state === 'not_checked' ? 'authentication_required' : 'database_or_migrations_not_verified';
        report.checks.push({ id: 'runtime.readiness', state: report.migrations.readiness.state, reason: report.migrations.readiness.reason });
      }
    }
  }
  if (report.checks.some((check) => check.state === 'fail')) { report.result = 'fail'; report.exit_code = 1; }
  else if (report.checks.some((check) => check.state === 'unknown' || (check.id.startsWith('http.') && check.state === 'not_checked')) || !report.target) { report.result = 'incomplete'; report.exit_code = 2; }
  else { report.result = 'pass'; report.exit_code = 0; }
  return report;
}

export const DEPLOYMENT_DOCTOR_USAGE = `BailingHub read-only deployment doctor
Usage: npm run doctor -- --deployment --url http://127.0.0.1:18900 --json
Options:
  --url <http(s) URL>       Explicit Core base URL, no credentials/query/fragment
  --json                   Print one JSON report (use npm run --silent for clean stdout)
  --expect-version <v>     Expected package version; otherwise use local package.json
  --expect-commit <SHA>    Expected 12-64 hex commit; otherwise local Git/build info
  --timeout-ms <100-30000> Per-request timeout, default 5000 ms, 64 KiB response cap
  --readiness              Also GET /health/ready (server reads its database/ledger)
  --help                  Show this help
Exit: 0 selected checks pass; 1 observed failure/mismatch; 2 incomplete; 64 invalid arguments.
No login, model calls, direct DB connection, migration, update or rollback. Protected
endpoints and the applied migration identity remain not_checked, including on exit 0.
`;

export async function runDeploymentDoctorCli(args: string[], root: string): Promise<number> {
  const options: DeploymentDoctorOptions = { root };
  let json = false;
  let invalid = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--deployment') continue;
    if (arg === '--help') { console.log(DEPLOYMENT_DOCTOR_USAGE); return 0; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--readiness') { options.readiness = true; continue; }
    const value = args[i + 1];
    if (!value || value.startsWith('--')) { invalid = true; continue; }
    if (arg === '--url') options.url = value;
    else if (arg === '--expect-version') { options.expectedVersion = value; invalid ||= !version(value); }
    else if (arg === '--expect-commit') { options.expectedCommit = value; invalid ||= !commit(value); }
    else if (arg === '--timeout-ms') { options.timeoutMs = /^\d+$/.test(value) ? Number(value) : NaN; invalid ||= !Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30_000; }
    else invalid = true;
    i++;
  }
  if (invalid) {
    // No argv values, URLs, headers, exception messages or response bodies are
    // ever included in the diagnostic error output.
    const failure = { schema: 'bailing.deployment-diagnostics.v1', result: 'invalid_arguments', exit_code: 64, reason: 'invalid_or_unsupported_argument' };
    if (json) console.log(JSON.stringify(failure));
    else console.error('Invalid deployment doctor arguments. Use --deployment --help.');
    return 64;
  }
  const report = await runDeploymentDoctor(options);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`BailingHub deployment doctor: ${report.result}`);
    for (const check of report.checks) console.log(`${check.state} ${check.id}: ${check.reason}`);
    console.log('Applied migration identity and protected endpoints: not_checked. Use --json for scope and details.');
  }
  return report.exit_code;
}
