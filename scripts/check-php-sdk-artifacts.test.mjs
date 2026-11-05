import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyPhpSdkArtifact } from './check-php-sdk-artifacts.mjs';

function fixture(t, driver) {
  const root = mkdtempSync(join(tmpdir(), 'php-artifact-check-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'sdk', 'php7');
  const stage = join(root, 'stage');
  const prefix = 'bailing-connect-php7';
  const staged = join(stage, prefix);
  mkdirSync(join(source, 'src'), { recursive: true });
  mkdirSync(join(source, 'tests'), { recursive: true });
  mkdirSync(join(root, 'web', 'connect'), { recursive: true });
  writeFileSync(join(source, 'src', 'Tool.php'), '<?php return "fixture";\n');
  // These tests exercise archive enforcement. The real SDK matrix drivers are
  // executed separately by the artifact command against the actual packages.
  const report = {
    sdk: 'php7', passed: true, matrixCases: 24, idempotenceCases: 6,
    checks: 171, errors: [], matrix: Array(24).fill({}), idempotence: Array(6).fill({}),
  };
  writeFileSync(join(source, 'tests', 'declaration-serialization.php'), driver ?? `<?php echo '${JSON.stringify(report)}';`);
  cpSync(source, staged, { recursive: true });
  const archive = join(root, 'web', 'connect', `${prefix}.tgz`);
  const pack = (members = [prefix]) => {
    const packed = spawnSync('tar', ['-czf', archive, '-C', stage, ...members], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
  };
  pack();
  return { root, source, staged, prefix, pack };
}

test('valid archive verifies complete file identity and both regression executions', (t) => {
  const { root } = fixture(t);
  const result = verifyPhpSdkArtifact({ root, sdk: 'php7' });
  assert.equal(result.fileCount, 2);
  assert.match(result.archiveSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.files.map((file) => file.path), ['src/Tool.php', 'tests/declaration-serialization.php']);
  assert.equal(result.sourceRegression.passed, true);
  assert.equal(result.artifactRegression.passed, true);
});

test('stale archive bytes fail before any generator is run', (t) => {
  const { root, source } = fixture(t);
  writeFileSync(join(source, 'src', 'Tool.php'), '<?php return "updated";\n');
  assert.throws(() => verifyPhpSdkArtifact({ root, sdk: 'php7' }), /archive bytes differ from source: src\/Tool.php/);
});

test('archive missing a source file is rejected', (t) => {
  const { root, staged, pack } = fixture(t);
  rmSync(join(staged, 'src', 'Tool.php'));
  pack();
  assert.throws(() => verifyPhpSdkArtifact({ root, sdk: 'php7' }), /archive file set differs.*missing=\["src\/Tool.php"\]/);
});

test('archive with an extra file is rejected', (t) => {
  const { root, staged, pack } = fixture(t);
  writeFileSync(join(staged, 'extra.php'), '<?php echo "unexpected";');
  pack();
  assert.throws(() => verifyPhpSdkArtifact({ root, sdk: 'php7' }), /unexpected=\["extra.php"\]/);
});

test('archive links are rejected without extracting them', (t) => {
  const { root, staged, pack } = fixture(t);
  symlinkSync('/outside/sdk', join(staged, 'link'));
  pack();
  assert.throws(() => verifyPhpSdkArtifact({ root, sdk: 'php7' }), /Archive links or special files are not allowed/);
});

test('duplicate archive members are rejected', (t) => {
  const { root, prefix, pack } = fixture(t);
  pack([prefix, `${prefix}/src/Tool.php`]);
  assert.throws(() => verifyPhpSdkArtifact({ root, sdk: 'php7' }), /Duplicate archive path/);
});

test('source symlinks are rejected', (t) => {
  const { root, source } = fixture(t);
  symlinkSync('/outside/sdk', join(source, 'link'));
  assert.throws(() => verifyPhpSdkArtifact({ root, sdk: 'php7' }), /SDK source symlinks are not allowed/);
});

test('regression failure cannot be reported as a valid artifact', (t) => {
  const { root } = fixture(t, '<?php fwrite(STDERR, "regression failed"); exit(1);');
  assert.throws(() => verifyPhpSdkArtifact({ root, sdk: 'php7' }), /php exited 1: regression failed/);
});

test('an incomplete successful regression report is rejected', (t) => {
  const { root } = fixture(t, '<?php echo \'{"sdk":"php7","passed":true,"matrixCases":1}\';');
  assert.throws(() => verifyPhpSdkArtifact({ root, sdk: 'php7' }), /generator regression is failed or incomplete/);
});

test('missing PHP runtime fails instead of silently skipping', (t) => {
  const { root } = fixture(t);
  assert.throws(() => verifyPhpSdkArtifact({ root, sdk: 'php7', phpCommand: join(root, 'missing-php') }), /ENOENT/);
});
