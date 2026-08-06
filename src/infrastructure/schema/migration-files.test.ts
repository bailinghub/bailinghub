import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOfficialMigrationFilenames } from './migration-files';

test('official migration filenames require one unique three-digit number', () => {
  assert.doesNotThrow(() => assertOfficialMigrationFilenames([
    '001_init.sql',
    '003_add_jobs.sql',
  ]));
  assert.throws(
    () => assertOfficialMigrationFilenames(['001_init.sql', 'notes.sql']),
    /非规范文件：notes\.sql/,
  );
  assert.throws(
    () => assertOfficialMigrationFilenames(['003_jobs.sql', '003_routes.sql']),
    /迁移编号重复：003=/,
  );
});
