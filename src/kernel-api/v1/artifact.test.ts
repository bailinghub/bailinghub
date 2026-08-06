import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BAILINGHUB_CORE_ARTIFACT_V1 } from './artifact';

const CORE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const EXPECTED_RETIRED_MIGRATIONS = [
  {
    filename: '020_provider_sign_version.sql',
    checksumSha256: '9b4ed1ca632a0dcca92a768671584cbc29d09a4d6501697631d355616f15a21e',
    byteLength: 564,
    replay: 'never',
  },
  {
    filename: '021_drop_provider_sign_version.sql',
    checksumSha256: '513ba9dfe031e785da09d931405cbcf867f703b2b7a6d0ec7077719082206466',
    byteLength: 407,
    replay: 'never',
  },
  {
    filename: '037_route_tools_shape.sql',
    checksumSha256: 'da87330abb088868827445a425e30bc6928b8ee47d4aeb680784fcf8d0a11fb4',
    byteLength: 1181,
    replay: 'never',
  },
];

test('Core artifact manifest is derived from the installed package and ordered migration bytes', () => {
  assert.equal(BAILINGHUB_CORE_ARTIFACT_V1.packageName, 'bailinghub');
  assert.match(BAILINGHUB_CORE_ARTIFACT_V1.version, /^\d+\.\d+\.\d+/);
  assert.equal(
    BAILINGHUB_CORE_ARTIFACT_V1.latestMigration,
    BAILINGHUB_CORE_ARTIFACT_V1.migrations.at(-1)?.filename,
  );
  assert.equal(new Set(BAILINGHUB_CORE_ARTIFACT_V1.migrations.map((item) => item.filename)).size, BAILINGHUB_CORE_ARTIFACT_V1.migrations.length);
  for (const migration of BAILINGHUB_CORE_ARTIFACT_V1.migrations) assert.match(migration.checksumSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(BAILINGHUB_CORE_ARTIFACT_V1.retiredMigrations, EXPECTED_RETIRED_MIGRATIONS);
  const activeFilenames = new Set(BAILINGHUB_CORE_ARTIFACT_V1.migrations.map((item) => item.filename));
  for (const retired of BAILINGHUB_CORE_ARTIFACT_V1.retiredMigrations) {
    assert.equal(activeFilenames.has(retired.filename), false);
    assert.equal(existsSync(join(CORE_ROOT, 'sql', retired.filename)), false);
  }
  assert.match(BAILINGHUB_CORE_ARTIFACT_V1.manifestSha256, /^[a-f0-9]{64}$/);
});
