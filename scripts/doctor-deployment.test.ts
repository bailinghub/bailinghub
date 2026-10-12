import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDeploymentDoctor, type DeploymentDoctorReport } from './doctor-deployment';
import { handlePublicHttpFor, type PublicHttpDeps } from '../src/routes/public';
import type { AppConfig } from '../src/core/config/config';
import { buildMeta } from '../src/core/platform/version';
import { LocalInstanceBrandingProvider } from '../src/infrastructure/config/local-instance-branding-provider';

const SHA = 'abcdef0123456789abcdef0123456789abcdef0123';
const OTHER_SHA = '0123456789abcdef0123456789abcdef0123456789';
const VERSION = '0.9.1';
const SECRET = 'test-credential-that-must-stay-private';
const CLI = fileURLToPath(new URL('./doctor.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));

function fixture(t: TestContext, overrides: { build?: unknown; pkg?: unknown; withConfig?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'bailing-deployment-doctor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'sql'));
  writeFileSync(join(root, 'package.json'), JSON.stringify(overrides.pkg ?? {
    name: 'bailinghub', version: VERSION,
    scripts: { smoke: 'touch unsafe-model-call', typecheck: 'touch unsafe-typecheck' },
  }));
  writeFileSync(join(root, 'sql', '001_initial.sql'), '-- packaged migration, never run\n');
  writeFileSync(join(root, 'sql', '064_period_plan_allowance.sql'), '-- packaged migration, never run\n');
  writeFileSync(join(root, 'build-info.json'), JSON.stringify(overrides.build ?? { build: { commit: SHA } }));
  if (overrides.withConfig) {
    writeFileSync(join(root, '.env'), `BAILING_TOKEN=${SECRET}\nBAILING_MYSQL_PASSWORD=${SECRET}\n`);
    writeFileSync(join(root, 'config.json'), `{invalid-json-and-private-value:${SECRET}}`);
  }
  return root;
}

function payloads(): Record<string, unknown> {
  return {
    '/health': { status: 'ok', app: { name: 'bailinghub', version: VERSION }, build: { commit: SHA.slice(0, 12) }, paused: false, backend: 'mysql' },
    '/version': { app: { name: 'bailinghub', version: VERSION }, build: { commit: SHA.slice(0, 12) }, migrations: { latest: '064_period_plan_allowance.sql', total: 2 } },
    '/health/ready': { status: 'ready', checks: { database: 'ok', migrations: { status: 'ok', pending: 0 } } },
  };
}

type Seen = { method: string | undefined; path: string | undefined; authorization: string | undefined; cookie: string | undefined };

async function httpFixture(t: TestContext, handler?: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const bodies = payloads();
  const server = createServer((req, res) => {
    seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });
    if (handler) handler(req, res);
    else { res.writeHead(bodies[req.url ?? ''] ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(bodies[req.url ?? ''] ?? { error: SECRET })); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, seen };
}

function check(report: DeploymentDoctorReport, id: string) {
  const entry = report.checks.find((item) => item.id === id);
  assert.ok(entry, `missing ${id}`);
  return entry;
}

test('without an explicit target, report incomplete and do not discover URLs or load config', async (t) => {
  const root = fixture(t, { withConfig: true });
  const report = await runDeploymentDoctor({ root });
  assert.equal(report.exit_code, 2);
  assert.equal(report.runtime.state, 'not_checked');
  assert.equal(report.configuration.local_files.config_json, 'present');
  assert.equal(report.configuration.local_files.dotenv, 'present');
  assert.equal(report.configuration.state, 'unknown');
  assert.equal(report.configuration.credentials, 'not_checked');
  assert.deepEqual(report.scope.paths, []);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('default checks only GET health/version, verify reported identities, and keep DB/schema protected checks separate', async (t) => {
  const root = fixture(t, { withConfig: true });
  const server = await httpFixture(t);
  const report = await runDeploymentDoctor({ root, url: server.url });
  assert.equal(report.result, 'pass');
  assert.equal(report.exit_code, 0);
  assert.equal(report.source.commit_basis, 'build_info');
  assert.equal(report.comparison.commit_matches, true);
  assert.equal(report.comparison.state, 'verified');
  assert.equal(report.runtime.state, 'verified');
  assert.equal(report.runtime.basis, 'reported_metadata');
  assert.equal(report.runtime.artifact_integrity, 'not_checked');
  assert.equal(report.source.artifact_integrity, 'not_checked');
  assert.equal(report.database.state, 'not_checked');
  assert.equal(report.migrations.identity.state, 'not_checked');
  assert.equal(report.migrations.readiness.state, 'not_checked');
  assert.equal(report.protected_endpoints.state, 'not_checked');
  assert.equal(report.upgrade.state, 'not_checked');
  assert.equal(check(report, 'artifact.migrations').state, 'pass');
  assert.deepEqual(server.seen.map(({ method, path }) => ({ method, path })), [
    { method: 'GET', path: '/health' }, { method: 'GET', path: '/version' },
  ]);
  assert.ok(server.seen.every((req) => !req.authorization && !req.cookie));
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('explicit readiness checks only its public summary, not an applied migration identity', async (t) => {
  const root = fixture(t);
  const server = await httpFixture(t);
  const report = await runDeploymentDoctor({ root, url: server.url, readiness: true });
  assert.equal(report.exit_code, 0);
  assert.equal(report.migrations.readiness.state, 'verified');
  assert.equal(report.migrations.readiness.pending, 0);
  assert.equal(report.migrations.identity.state, 'not_checked');
  assert.equal(report.database.state, 'not_checked');
  assert.deepEqual(server.seen.map((req) => req.path), ['/health', '/version', '/health/ready']);
});

test('the existing public HTTP implementation works with this doctor; default mode never invokes its readiness callback', async (t) => {
  const root = fixture(t);
  let readinessCalls = 0;
  const unexpected = () => { throw new Error('unexpected non-diagnostic route'); };
  const deps: PublicHttpDeps = {
    cfg: { root, state: { backend: 'mysql' } } as unknown as AppConfig,
    configStore: null, brandingProvider: new LocalInstanceBrandingProvider(null),
    queue: { stats: () => ({ running: 0, waiting: 0 }) }, isPaused: () => false,
    readiness: async () => { readinessCalls++; return { ready: true, checks: { database: 'ok', migrations: { status: 'ok', pending: 0 } } }; },
    serveConsole: unexpected, serveChatDemo: unexpected,
    handleChat: async () => unexpected(), handleChatConfig: async () => unexpected(),
    handleChatEvents: async () => unexpected(), handleChatThread: async () => unexpected(),
    handleChatUpload: async () => unexpected(), handleChatRate: async () => unexpected(),
  };
  const server = await httpFixture(t, (req, res) => {
    void handlePublicHttpFor(deps, req, res, new URL(req.url ?? '/', 'http://127.0.0.1')).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(() => { res.writeHead(500); res.end(); });
  });
  // CI may supply GITHUB_SHA; use the existing build function's same stated
  // commit without changing or trusting a process environment credential.
  const expectedCommit = String(buildMeta(root).commit);
  const report = await runDeploymentDoctor({ root, url: server.url, expectedCommit });
  assert.equal(report.exit_code, 0);
  assert.equal(readinessCalls, 0);
  const ready = await runDeploymentDoctor({ root, url: server.url, expectedCommit, readiness: true });
  assert.equal(ready.exit_code, 0);
  assert.equal(readinessCalls, 1);
  assert.deepEqual(server.seen.map((req) => req.path), ['/health', '/version', '/health', '/version', '/health/ready']);
});

test('readiness failure, skipped database, and required authentication remain distinguishable', async (t) => {
  const root = fixture(t);
  const bodies = payloads();
  let mode = 'failed';
  const server = await httpFixture(t, (req, res) => {
    if (req.url === '/health/ready') {
      if (mode === 'auth') { res.writeHead(401); res.end(SECRET); }
      else {
        res.writeHead(mode === 'failed' ? 503 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(mode === 'failed'
          ? { status: 'not_ready', checks: { database: 'failed', migrations: { status: 'failed', pending: 0 } }, error: SECRET }
          : { status: 'ready', checks: { database: 'skipped', migrations: { status: 'skipped', pending: 0 } } }));
      }
    } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(bodies[req.url ?? ''])); }
  });
  const failed = await runDeploymentDoctor({ root, url: server.url, readiness: true });
  assert.equal(failed.exit_code, 1);
  assert.equal(failed.migrations.readiness.reason, 'server_reports_not_ready');
  mode = 'skipped';
  const skipped = await runDeploymentDoctor({ root, url: server.url, readiness: true });
  assert.equal(skipped.exit_code, 2);
  assert.equal(skipped.migrations.readiness.state, 'unknown');
  mode = 'auth';
  const auth = await runDeploymentDoctor({ root, url: server.url, readiness: true });
  assert.equal(auth.exit_code, 2);
  assert.equal(auth.migrations.readiness.state, 'not_checked');
  assert.equal(check(auth, 'http.readiness').reason, 'authentication_required');
  for (const report of [failed, skipped, auth]) assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('a version or commit mismatch fails; absence of a commit never becomes verified', async (t) => {
  const root = fixture(t);
  const bodies = payloads();
  let body: unknown = { app: { name: 'bailinghub', version: VERSION }, build: { commit: OTHER_SHA }, migrations: { latest: '064_period_plan_allowance.sql', total: 2 } };
  const server = await httpFixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/version' ? body : bodies[req.url ?? '']));
  });
  const mismatch = await runDeploymentDoctor({ root, url: server.url });
  assert.equal(mismatch.exit_code, 1);
  assert.equal(mismatch.comparison.state, 'mismatch');
  assert.equal(check(mismatch, 'runtime.consistency').state, 'fail');
  body = { app: { name: 'bailinghub', version: VERSION }, migrations: { latest: '064_period_plan_allowance.sql', total: 2 } };
  const noCommit = await runDeploymentDoctor({ root, url: server.url });
  assert.equal(noCommit.exit_code, 2);
  assert.equal(noCommit.comparison.state, 'unknown');
  assert.equal(noCommit.runtime.state, 'unknown');
  body = { app: { name: 'bailinghub', version: '0.9.0' }, build: { commit: SHA }, migrations: { latest: '064_period_plan_allowance.sql', total: 2 } };
  const oldVersion = await runDeploymentDoctor({ root, url: server.url });
  assert.equal(oldVersion.exit_code, 1);
  assert.equal(oldVersion.comparison.version_matches, false);
});

test('a source without a commit stays incomplete even with a matching explicit runtime expectation', async (t) => {
  const root = fixture(t, { build: {} });
  const server = await httpFixture(t);
  const report = await runDeploymentDoctor({ root, url: server.url, expectedVersion: VERSION, expectedCommit: SHA });
  assert.equal(report.exit_code, 2);
  assert.equal(report.source.state, 'unknown');
  assert.equal(check(report, 'source.commit').reason, 'local_commit_unavailable');
  assert.equal(report.comparison.state, 'verified');
});

test('wrong application and secret-shaped fields are not printed or accepted as identity', async (t) => {
  const root = fixture(t);
  const server = await httpFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', app: { name: SECRET, version: SECRET }, build: { commit: SECRET }, migrations: { latest: SECRET, total: SECRET }, config: { password: SECRET }, error: SECRET }));
  });
  const report = await runDeploymentDoctor({ root, url: server.url });
  assert.equal(report.exit_code, 1);
  assert.equal(report.runtime.state, 'mismatch');
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('explicit expected identity can compare a different artifact without claiming local migration alignment', async (t) => {
  const root = fixture(t, { pkg: { name: 'bailinghub', version: '0.9.0' }, build: { build: { commit: OTHER_SHA } } });
  const server = await httpFixture(t);
  const report = await runDeploymentDoctor({ root, url: server.url, expectedVersion: VERSION, expectedCommit: SHA });
  assert.equal(report.exit_code, 0);
  assert.equal(report.source.version, '0.9.0');
  assert.equal(report.comparison.basis, 'explicit_expectation');
  assert.equal(check(report, 'artifact.migrations').state, 'not_checked');
});

test('local Git dirtiness prevents an artifact identity claim; fsmonitor hooks do not run', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', 'package.json', 'build-info.json', 'sql'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Deployment Doctor Test', '-c', 'user.email=doctor@example.invalid', 'commit', '--quiet', '-m', 'local fixture'], { cwd: root });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const marker = join(root, '.git', 'unexpected-fsmonitor-hook');
  const hook = join(root, '.git', 'fsmonitor.sh');
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: root });
  const bodies = payloads();
  for (const path of ['/health', '/version']) (bodies[path] as { build: { commit: string } }).build.commit = sha;
  const server = await httpFixture(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(bodies[req.url ?? ''])); });
  const clean = await runDeploymentDoctor({ root, url: server.url });
  assert.equal(clean.source.worktree, 'clean');
  assert.equal(clean.exit_code, 0);
  assert.equal(existsSync(marker), false);
  writeFileSync(join(root, 'sql', '001_initial.sql'), '-- uncommitted source changes\n');
  const dirty = await runDeploymentDoctor({ root, url: server.url });
  assert.equal(dirty.source.worktree, 'dirty');
  assert.equal(dirty.exit_code, 2);
  assert.equal(dirty.comparison.state, 'unknown');
  assert.equal(check(dirty, 'artifact.comparison').reason, 'local_worktree_modified');
  assert.equal(existsSync(marker), false);
  const explicit = await runDeploymentDoctor({ root, url: server.url, expectedCommit: sha, expectedVersion: VERSION });
  assert.equal(explicit.exit_code, 0);
  assert.equal(explicit.source.worktree, 'dirty');
  assert.equal(explicit.runtime.artifact_integrity, 'not_checked');
});

test('authentication required for a selected public check reports incomplete without trying protected APIs', async (t) => {
  const root = fixture(t);
  const bodies = payloads();
  const server = await httpFixture(t, (req, res) => {
    if (req.url === '/health') { res.writeHead(403); res.end(SECRET); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(bodies[req.url ?? ''])); }
  });
  const report = await runDeploymentDoctor({ root, url: server.url });
  assert.equal(report.exit_code, 2);
  assert.equal(check(report, 'http.health').state, 'not_checked');
  assert.equal(check(report, 'http.health').reason, 'authentication_required');
  assert.equal(server.seen.length, 2);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('userinfo, query, fragment, invalid protocols and malformed URLs produce no request or credential output', async (t) => {
  const root = fixture(t);
  const server = await httpFixture(t);
  for (const url of [
    server.url.replace('http://', `http://user:${SECRET}@`), `${server.url}/?token=${SECRET}`,
    `${server.url}/#${SECRET}`, `file:///${SECRET}`, SECRET,
  ]) {
    const report = await runDeploymentDoctor({ root, url });
    assert.equal(report.exit_code, 1);
    assert.equal(report.target, null);
    assert.equal(check(report, 'target').reason, 'invalid_or_credential_bearing_url');
    assert.ok(!JSON.stringify(report).includes(SECRET));
  }
  assert.deepEqual(server.seen, []);
});

test('both same-origin and cross-origin redirects are rejected without following their location', async (t) => {
  const root = fixture(t);
  const destination = await httpFixture(t);
  let location = `${destination.url}/?token=${SECRET}`;
  const server = await httpFixture(t, (_req, res) => { res.writeHead(302, { location }); res.end(SECRET); });
  const cross = await runDeploymentDoctor({ root, url: server.url });
  assert.equal(cross.exit_code, 1);
  assert.equal(check(cross, 'http.health').reason, 'redirect_rejected');
  assert.deepEqual(destination.seen, []);
  location = `${server.url}/redirected?token=${SECRET}`;
  const same = await runDeploymentDoctor({ root, url: server.url });
  assert.equal(same.exit_code, 1);
  assert.deepEqual(server.seen.map((req) => req.path), ['/health', '/version', '/health', '/version']);
  for (const report of [cross, same]) assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('response cap rejects both declared and streamed oversize JSON', async (t) => {
  const root = fixture(t);
  let declared = true;
  const server = await httpFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', ...(declared ? { 'content-length': '100000' } : {}) });
    res.end(`{"error":"${SECRET}${'x'.repeat(70000)}"}`);
  });
  const length = await runDeploymentDoctor({ root, url: server.url });
  assert.equal(length.exit_code, 1);
  assert.equal(check(length, 'http.health').reason, 'response_too_large');
  declared = false;
  const streamed = await runDeploymentDoctor({ root, url: server.url });
  assert.equal(streamed.exit_code, 1);
  assert.equal(check(streamed, 'http.health').reason, 'response_too_large');
  for (const report of [length, streamed]) assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('timeout covers both response headers and streaming bodies without printing network errors', async (t) => {
  const root = fixture(t);
  let headers = false;
  const server = await httpFixture(t, (_req, res) => {
    if (headers) { res.writeHead(200, { 'content-type': 'application/json' }); res.write(`{"error":"${SECRET}`); }
  });
  for (const bodyTimeout of [false, true]) {
    headers = bodyTimeout;
    const start = performance.now();
    const report = await runDeploymentDoctor({ root, url: server.url, timeoutMs: 100 });
    assert.equal(report.exit_code, 1);
    assert.equal(check(report, 'http.health').reason, 'request_timeout');
    assert.ok(performance.now() - start < 2000);
    assert.ok(!JSON.stringify(report).includes(SECRET));
  }
});

test('content type, invalid JSON and non-object JSON have stable redacted errors', async (t) => {
  const root = fixture(t);
  let mode = 'html';
  const server = await httpFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': mode === 'html' ? 'text/html' : 'application/json' });
    res.end(mode === 'array' ? JSON.stringify([SECRET]) : SECRET);
  });
  for (const [nextMode, expected] of [['html', 'unexpected_content_type'], ['json', 'invalid_json'], ['array', 'invalid_json_object']]) {
    mode = nextMode!;
    const report = await runDeploymentDoctor({ root, url: server.url });
    assert.equal(report.exit_code, 1);
    assert.equal(check(report, 'http.health').reason, expected);
    assert.ok(!JSON.stringify(report).includes(SECRET));
  }
});

test('unreachable target gets a stable reason without host error details', async (t) => {
  const root = fixture(t);
  const report = await runDeploymentDoctor({ root, url: 'http://127.0.0.1:0', timeoutMs: 100 });
  assert.equal(report.exit_code, 1);
  assert.equal(check(report, 'http.health').reason, 'unreachable');
});

test('mounted base paths append only the allowlisted suffix and are not echoed', async (t) => {
  const root = fixture(t);
  const bodies = payloads();
  const prefix = '/configured-prefix';
  const server = await httpFixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(bodies[req.url?.slice(prefix.length) ?? '']));
  });
  const report = await runDeploymentDoctor({ root, url: `${server.url}${prefix}/` });
  assert.equal(report.exit_code, 0);
  assert.equal(report.target?.base_path, 'configured_not_printed');
  assert.deepEqual(server.seen.map((req) => req.path), [`${prefix}/health`, `${prefix}/version`]);
  assert.ok(!JSON.stringify(report).includes(prefix));
});

test('invalid library expectations stay redacted, including when URL is missing', async (t) => {
  const root = fixture(t);
  const server = await httpFixture(t);
  for (const url of [undefined, server.url]) {
    const report = await runDeploymentDoctor({ root, url, expectedVersion: SECRET, expectedCommit: SECRET });
    assert.ok(!JSON.stringify(report).includes(SECRET));
  }
  assert.deepEqual(server.seen, []);
});

test('CLI deployment mode is JSON-only, ignores legacy FULL/SMOKE and credential environment, and has machine exit codes', (t) => {
  const root = fixture(t, { withConfig: true });
  const child = spawnSync(process.execPath, ['--import', TSX, CLI, '--deployment', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, BAILING_DOCTOR_FULL: '1', BAILING_DOCTOR_SMOKE: '1', BAILING_SMOKE_TOKEN: SECRET, BAILING_SMOKE_URL: `http://user:${SECRET}@127.0.0.1:9` }, timeout: 10_000,
  });
  assert.equal(child.status, 2, child.stderr);
  assert.equal(child.stderr, '');
  const report = JSON.parse(child.stdout);
  assert.equal(report.mode, 'deployment');
  assert.equal(report.exit_code, child.status);
  assert.ok(!child.stdout.includes(SECRET));
  assert.equal(existsSync(join(root, 'unsafe-model-call')), false);
  assert.equal(existsSync(join(root, 'unsafe-typecheck')), false);
  for (const args of [['--token', SECRET], ['--timeout-ms', '99'], ['--expect-commit', SECRET]]) {
    const invalid = spawnSync(process.execPath, ['--import', TSX, CLI, '--deployment', ...args, '--json'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(invalid.status, 64, invalid.stderr);
    assert.equal(JSON.parse(invalid.stdout).reason, 'invalid_or_unsupported_argument');
    assert.ok(!invalid.stdout.includes(SECRET));
  }
});
