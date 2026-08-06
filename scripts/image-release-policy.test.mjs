import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { resolveImageReleasePolicy } from './image-release-policy.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('prerelease tags can never update latest', () => {
  assert.deepEqual(
    resolveImageReleasePolicy({ tag: 'v0.3.0-rc.1' }),
    { tag: '0.3.0-rc.1', prerelease: true, pushLatest: false },
  );
  assert.deepEqual(
    resolveImageReleasePolicy({ tag: '0.3.0-beta.2', requestedLatest: 'true' }),
    { tag: '0.3.0-beta.2', prerelease: true, pushLatest: false },
  );
});

test('stable tags update latest by default and respect an explicit opt-out', () => {
  assert.deepEqual(
    resolveImageReleasePolicy({ tag: 'v0.3.0' }),
    { tag: '0.3.0', prerelease: false, pushLatest: true },
  );
  assert.deepEqual(
    resolveImageReleasePolicy({ tag: '0.3.0', requestedLatest: false }),
    { tag: '0.3.0', prerelease: false, pushLatest: false },
  );
});

test('invalid or ambiguous release inputs fail closed', () => {
  for (const tag of ['', 'latest', '0.3', '0.3.0+build.1', '0.3.0-rc.01']) {
    assert.throws(() => resolveImageReleasePolicy({ tag }), /image tag/);
  }
  assert.throws(
    () => resolveImageReleasePolicy({ tag: '0.3.0', requestedLatest: 'yes' }),
    /requested latest/,
  );
});

test('CLI emits GitHub output fields using the same fail-closed policy', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/image-release-policy.mjs', '--tag', 'v0.3.0-rc.1', '--requested-latest', 'true'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'tag=0.3.0-rc.1\nprerelease=true\npush_latest=false\n');
});

test('both image publication paths delegate latest policy to the checked script', () => {
  const workflow = readFileSync(resolve(ROOT, '.github/workflows/images.yml'), 'utf8');
  assert.equal((workflow.match(/node scripts\/image-release-policy\.mjs/g) ?? []).length, 2);
  assert.equal((workflow.match(/steps\.meta\.outputs\.push_latest/g) ?? []).length >= 2, true);
  assert.equal(workflow.includes('latest="$requested_latest"'), false);
  assert.equal(workflow.includes('${{ inputs.push_latest }}" = "true"'), false);
});
