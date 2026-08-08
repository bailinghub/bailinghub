import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import {
  checkReleaseConsistency,
  releaseConsistencyFiles,
} from './check-release-consistency.mjs';

const repoRoot = resolve(import.meta.dirname, '..');

function createFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'bailinghub-release-consistency-'));
  for (const relativePath of releaseConsistencyFiles) {
    const source = resolve(repoRoot, relativePath);
    const destination = resolve(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  const { stableVersion } = checkReleaseConsistency({ root: repoRoot });
  for (const suffix of ['.md', '.en.md']) {
    const source = resolve(repoRoot, `docs/RELEASE_NOTES_v${stableVersion}${suffix}`);
    const destination = resolve(root, `docs/RELEASE_NOTES_v${stableVersion}${suffix}`);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  return root;
}

function updateJson(root, relativePath, update) {
  const path = resolve(root, relativePath);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  update(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test('current release surface is internally consistent', () => {
  const result = checkReleaseConsistency({ root: repoRoot });
  assert.deepEqual(result.findings, []);
  assert.equal(result.version, '0.3.3');
  assert.equal(result.stableVersion, '0.3.3');
  assert.equal(result.publishTag, 'latest');
});

for (const [label, tag] of [
  ['missing', undefined],
  ['wrong', 'latest'],
]) {
  test(`RC ${label} next publish tag is rejected`, () => {
    const root = createFixture();
    try {
      updateJson(root, 'package.json', (pkg) => {
        pkg.version = '0.3.3-rc.1';
        if (tag === undefined) delete pkg.publishConfig;
        else pkg.publishConfig = { tag };
      });
      updateJson(root, 'package-lock.json', (lock) => {
        lock.version = '0.3.3-rc.1';
        lock.packages[''].version = '0.3.3-rc.1';
      });

      const result = checkReleaseConsistency({ root });
      assert.ok(
        result.findings.some((finding) => finding.includes('prerelease versions must use publishConfig.tag "next"')),
        result.findings.join('\n'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('mismatched image tag is rejected before release', () => {
  const root = createFixture();
  try {
    const composePath = resolve(root, 'docker-compose.images.yml');
    const compose = readFileSync(composePath, 'utf8').replace(
      /bailinghub:(\d+\.\d+\.\d+)/,
      'bailinghub:0.0.0',
    );
    writeFileSync(composePath, compose);

    const result = checkReleaseConsistency({ root });
    assert.ok(
      result.findings.some((finding) => finding.includes('bailinghub default image tag is 0.0.0')),
      result.findings.join('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tag and package version mismatch is rejected', () => {
  const result = checkReleaseConsistency({ root: repoRoot, expected: 'v9.9.9' });
  assert.ok(
    result.findings.some((finding) => finding.includes('release ref: expected 9.9.9')),
    result.findings.join('\n'),
  );
});

test('stable version cannot retain the next publish tag', () => {
  const root = createFixture();
  try {
    const { stableVersion } = checkReleaseConsistency({ root });
    updateJson(root, 'package.json', (pkg) => {
      pkg.version = stableVersion;
      pkg.publishConfig = { tag: 'next' };
    });
    updateJson(root, 'package-lock.json', (lock) => {
      lock.version = stableVersion;
      lock.packages[''].version = stableVersion;
    });

    const result = checkReleaseConsistency({ root });
    assert.ok(
      result.findings.some((finding) => finding.includes('stable versions may only use publishConfig.tag "latest" or omit it')),
      result.findings.join('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
