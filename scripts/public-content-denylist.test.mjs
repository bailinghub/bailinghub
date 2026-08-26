import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PUBLIC_DENYLIST_FILE_ENV,
  PUBLIC_DENYLIST_JSON_ENV,
  findPublicContentDenylistMatches,
  loadPrivateExactTextDenylist,
} from './public-content-denylist.mjs';

const PLACEHOLDER = 'DEPLOYMENT_ONLY_MARKER_ALPHA_42';

test('loads neutral exact text markers from CI JSON', () => {
  const values = loadPrivateExactTextDenylist({
    env: { [PUBLIC_DENYLIST_JSON_ENV]: JSON.stringify([PLACEHOLDER]) },
  });
  assert.deepEqual(values, [PLACEHOLDER]);
  assert.deepEqual(findPublicContentDenylistMatches(`prefix ${PLACEHOLDER} suffix`, values), ['private exact text #1']);
});

test('loads neutral exact text markers from a repository-external file', () => {
  const externalRoot = mkdtempSync(join(tmpdir(), 'bailinghub-denylist-test-'));
  const file = join(externalRoot, 'denylist.json');
  writeFileSync(file, JSON.stringify([PLACEHOLDER]));
  try {
    assert.deepEqual(loadPrivateExactTextDenylist({
      root: process.cwd(),
      env: { [PUBLIC_DENYLIST_FILE_ENV]: file },
    }), [PLACEHOLDER]);
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('rejects a denylist file stored inside the repository', () => {
  assert.throws(
    () => loadPrivateExactTextDenylist({
      root: process.cwd(),
      env: { [PUBLIC_DENYLIST_FILE_ENV]: join(process.cwd(), 'package.json') },
    }),
    /must point outside the repository/,
  );
});

test('keeps generic rules independent of deployment values', () => {
  const marker = `github_pat_${'A'.repeat(24)}`;
  const neutralUserPath = ['/Users', 'example', 'project', 'file.txt'].join('/');
  assert.deepEqual(findPublicContentDenylistMatches(marker), ['GitHub personal access token']);
  assert.deepEqual(findPublicContentDenylistMatches(neutralUserPath), ['local user absolute path']);
});
