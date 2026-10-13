import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const INSTALLER = fileURLToPath(new URL('./install.sh', import.meta.url));
const source = readFileSync(INSTALLER, 'utf8');
const mainOffset = source.lastIndexOf('\nmain "$@"');
assert.ok(mainOffset > 0, 'installer entry point must be identifiable');
const functions = source.slice(0, mainOffset);
const SYNTHETIC_VALUE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

function hostCommand(name) {
  const result = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'fixture-command', name], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`Test prerequisite missing: ${name}`);
  return result.stdout.trim();
}

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
}

function fixture(t, opensslBody) {
  const root = mkdtempSync(join(tmpdir(), 'bailing-install-secrets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), app = join(root, 'app');
  mkdirSync(bin);
  mkdirSync(join(app, 'scripts'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{"name":"synthetic-install-fixture","version":"0.9.1"}\n');
  writeFileSync(join(app, 'docker-compose.yml'), 'services: {}\n');
  writeFileSync(join(app, 'docker-compose.images.yml'), 'services: {}\n');
  for (const name of ['cat', 'sed', 'head', 'grep', 'cut', 'chmod', 'tr']) symlinkSync(hostCommand(name), join(bin, name));
  // These legacy-fallback substitutes make the old timestamp path succeed.
  // All outputs are public synthetic data; no host clock or credentials are read.
  executable(join(bin, 'date'), "printf '%s\\n' 1791864000");
  executable(join(bin, 'sha256sum'), `printf '%s  -\\n' '${'0'.repeat(64)}'`);
  executable(join(bin, 'awk'), 'read -r line\nprintf \'%s\\n\' "${line%% *}"');
  executable(join(bin, 'uname'), "printf '%s\\n' x86_64");
  for (const name of ['git', 'curl', 'tar']) executable(join(bin, name), 'exit 0');
  executable(join(bin, 'docker'), 'printf \'%s\\n\' "$*" >> "$BAILING_TEST_DOCKER_CALLS"\nexit 0');
  if (opensslBody !== undefined) executable(join(bin, 'openssl'), opensslBody);
  const env = {
    PATH: bin,
    LC_ALL: 'C',
    BAILING_INSTALL_DIR: app,
    BAILING_INSTALL_MODE: 'image',
    BAILING_INSTALL_SKIP_SMOKE: '1',
    BAILING_SKIP_PORT_CHECK: '1',
    BAILING_PUBLIC_HOST: '127.0.0.1',
    BAILING_TEST_DOCKER_CALLS: join(root, 'docker-calls'),
    BAILING_TEST_OPENSSL_CALLS: join(root, 'openssl-calls'),
    BAILING_TEST_OPENSSL_COUNT: join(root, 'openssl-count'),
  };
  return { root, bin, app, env };
}

function runFunctions(f, commands = 'secret') {
  return spawnSync('/bin/sh', ['-s'], { cwd: f.app, env: f.env, input: `${functions}\n${commands}\n`, encoding: 'utf8', timeout: 5000 });
}

function runInstaller(f) {
  // Full entry point, but every external installation/network/container command
  // is confined to a substitute. Any .env is a disposable synthetic fixture.
  return spawnSync('/bin/sh', [INSTALLER], { cwd: f.app, env: f.env, encoding: 'utf8', timeout: 5000 });
}

function assertStopped(result) {
  assert.equal(result.error === undefined, true, 'shell must finish without a harness error');
  assert.notEqual(result.status, 0, 'unsafe credential generation must fail');
  assert.equal(result.stdout.includes(SYNTHETIC_VALUE), false, 'generated output must not be disclosed on failure');
  assert.equal(result.stderr.includes(SYNTHETIC_VALUE), false, 'random producer output must not enter error logs');
  assert.equal(result.stderr.includes('producer-private-error'), false, 'raw producer stderr must not enter error logs');
  assert.equal(result.stderr.includes('[bailinghub] ERROR:'), true, 'failure must have a stable installer error');
}

function assertNoInstallAfterFailure(f) {
  assert.equal(existsSync(join(f.app, '.env')), false, 'failed generation must not create an environment file');
  const calls = readFileSync(f.env.BAILING_TEST_DOCKER_CALLS, 'utf8').split('\n');
  assert.equal(calls.some((line) => line.startsWith('compose ') && line.includes(' up ')), false, 'failed generation must not start containers');
}

const countingRandomSubstitute = `
[ "$#" -eq 3 ] && [ "$1" = rand ] && [ "$2" = -base64 ] && [ "$3" = 24 ] || exit 2
printf '%s\\n' "$*" >> "$BAILING_TEST_OPENSSL_CALLS"
n=0
if [ -f "$BAILING_TEST_OPENSSL_COUNT" ]; then read -r n < "$BAILING_TEST_OPENSSL_COUNT"; fi
n=$((n + 1))
printf '%s\\n' "$n" > "$BAILING_TEST_OPENSSL_COUNT"
printf '%032d\\n' "$n"
`;

test('installer retains POSIX sh syntax', () => {
  const result = spawnSync('/bin/sh', ['-n', INSTALLER], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'installer must parse without Bash pipefail');
});

test('missing openssl fails without a predictable fallback', (t) => {
  assertStopped(runFunctions(fixture(t)));
});

for (const [name, body] of [
  ['producer failure even with plausible stdout', `printf '%s\\n' '${SYNTHETIC_VALUE}'\nprintf '%s\\n' producer-private-error >&2\nexit 1`],
  ['producer failure without stdout', 'printf \'%s\\n\' producer-private-error >&2\nexit 1'],
  ['empty successful output', 'exit 0'],
  ['truncated successful output', `printf '%s\\n' '${'A'.repeat(31)}'`],
  ['oversized successful output', `printf '%s\\n' '${'A'.repeat(33)}'`],
  ['non-Base64 successful output', `printf '%s\\n' '${'A'.repeat(31)}!'`],
  ['non-ASCII successful output', `printf '%s\\n' '${'A'.repeat(31)}é'`],
  ['embedded newline in successful output', `printf '%s\\n%s\\n' '${'A'.repeat(16)}' '${'A'.repeat(16)}'`],
]) {
  test(`${name} stops credential generation`, (t) => {
    assertStopped(runFunctions(fixture(t, body)));
  });
}

test('valid output uses the 24-byte Base64 generator directly', (t) => {
  const f = fixture(t, countingRandomSubstitute);
  const result = runFunctions(f, 'value=$(secret)\nprintf \'%s\\n\' "$value"');
  assert.equal(result.status, 0, 'valid random producer must succeed');
  assert.equal(/^[A-Za-z0-9+/]{32}\n$/.test(result.stdout), true, 'encoding must retain 24 bytes without padding');
  assert.equal(result.stderr, '');
  assert.equal(readFileSync(f.env.BAILING_TEST_OPENSSL_CALLS, 'utf8'), 'rand -base64 24\n');
});

test('real openssl generates distinct 24-byte credentials without logging their values', (t) => {
  const f = fixture(t);
  symlinkSync(hostCommand('openssl'), join(f.bin, 'openssl'));
  const result = runFunctions(f, 'i=0\nwhile [ "$i" -lt 6 ]; do value=$(secret); printf \'%s\\n\' "$value"; i=$((i + 1)); done');
  assert.equal(result.status, 0, 'system secure random producer must succeed');
  const values = result.stdout.trimEnd().split('\n');
  assert.equal(values.length, 6);
  assert.equal(values.every((value) => /^[A-Za-z0-9+/]{32}$/.test(value)), true);
  assert.equal(new Set(values).size, 6, 'separate generated credentials must be distinct');
  assert.equal(result.stderr, '');
});

test('full entry point stops before .env or startup when dependencies exist but openssl is missing', (t) => {
  const f = fixture(t);
  const result = runInstaller(f);
  assertStopped(result);
  assert.equal(result.stderr.includes('openssl'), true);
  assertNoInstallAfterFailure(f);
});

test('full entry point stops on a producer error that a trailing pipeline could mask', (t) => {
  const f = fixture(t, `printf '%s\\n' '${SYNTHETIC_VALUE}'\nprintf '%s\\n' producer-private-error >&2\nexit 1`);
  assertStopped(runInstaller(f));
  assertNoInstallAfterFailure(f);
});

test('failure after earlier credentials were generated still creates no partial .env or containers', (t) => {
  const f = fixture(t, countingRandomSubstitute.replace('printf \'%032d\\n\' "$n"', '[ "$n" -ne 4 ] || exit 1\nprintf \'%032d\\n\' "$n"'));
  assertStopped(runInstaller(f));
  assert.equal(readFileSync(f.env.BAILING_TEST_OPENSSL_COUNT, 'utf8').trim(), '4');
  assertNoInstallAfterFailure(f);
});

test('full entry point independently generates six synthetic credentials with private file permissions', (t) => {
  const f = fixture(t, countingRandomSubstitute);
  const result = runInstaller(f);
  assert.equal(result.status, 0, 'safe generation and stubbed installation must succeed');
  assert.equal(result.stderr, '');
  const content = readFileSync(join(f.app, '.env'), 'utf8');
  const keys = ['BAILING_TOKEN', 'BAILING_BOOTSTRAP_ADMIN_PASSWORD', 'BAILING_DEMO_MYSQL_ROOT_PASSWORD', 'BAILING_DEMO_MYSQL_PASSWORD', 'DEMO_TOOL_SECRET', 'DEMO_CLIENT_TOKEN'];
  const values = keys.map((key) => content.split('\n').find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1));
  assert.equal(values.every((value) => typeof value === 'string' && /^[A-Za-z0-9+/]{32}$/.test(value)), true);
  assert.equal(new Set(values).size, 6, 'independent credential slots must not share generated values');
  assert.equal(readFileSync(f.env.BAILING_TEST_OPENSSL_CALLS, 'utf8').trimEnd().split('\n').length, 6);
  assert.equal(statSync(join(f.app, '.env')).mode & 0o777, 0o600);
});

test('an existing environment is preserved byte-for-byte and does not need random regeneration', (t) => {
  const f = fixture(t);
  const envPath = join(f.app, '.env');
  const original = 'BAILING_DEMO_ADMIN_PASSWORD=synthetic-existing-admin\nDEMO_CLIENT_TOKEN=synthetic-existing-client\nBAILING_TOKEN=synthetic-existing-root\nBAILINGHUB_IMAGE=synthetic/existing:0.9.1\n';
  writeFileSync(envPath, original, { mode: 0o600 });
  const result = runInstaller(f);
  assert.equal(result.status, 0, 'existing installation must not generate replacement credentials');
  assert.equal(result.stderr, '');
  assert.equal(readFileSync(envPath, 'utf8') === original, true, 'existing environment must remain unchanged');
  assert.equal(existsSync(f.env.BAILING_TEST_OPENSSL_CALLS), false);
});
