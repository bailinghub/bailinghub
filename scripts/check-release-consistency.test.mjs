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
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  for (const suffix of ['.md', '.en.md']) {
    const source = resolve(repoRoot, `docs/RELEASE_NOTES_v${pkg.version}${suffix}`);
    const destination = resolve(root, `docs/RELEASE_NOTES_v${pkg.version}${suffix}`);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  return root;
}

test('current release surface is internally consistent', () => {
  const result = checkReleaseConsistency({ root: repoRoot });
  assert.deepEqual(result.findings, []);
});

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

