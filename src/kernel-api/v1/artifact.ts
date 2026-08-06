import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOfficialMigrationFilenames } from '../../infrastructure/schema/migration-files';
import {
  BAILINGHUB_RETIRED_CORE_MIGRATIONS_V1,
  type BailingHubRetiredCoreMigrationV1,
} from '../../infrastructure/schema/retired-migrations';

const CORE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface BailingHubCoreMigrationArtifactV1 {
  readonly filename: string;
  readonly checksumSha256: string;
}

export interface BailingHubCoreArtifactManifestV1 {
  readonly packageName: 'bailinghub';
  readonly version: string;
  readonly latestMigration: string;
  readonly migrations: readonly BailingHubCoreMigrationArtifactV1[];
  /** Known pre-public ledger records. They are evidence only and must never be replayed. */
  readonly retiredMigrations: readonly BailingHubRetiredCoreMigrationV1[];
  /** Stable digest over version, active migrations, and retired migration evidence. */
  readonly manifestSha256: string;
}

function readArtifactManifest(): BailingHubCoreArtifactManifestV1 {
  const pkg = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  const version = String(pkg.version ?? '');
  if (pkg.name !== 'bailinghub' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('invalid BailingHub Core artifact package metadata');
  }
  const directory = join(CORE_ROOT, 'sql');
  const filenames = readdirSync(directory).filter((filename) => filename.endsWith('.sql')).sort();
  assertOfficialMigrationFilenames(filenames);
  const migrations = filenames
    .map((filename) => Object.freeze({
      filename,
      checksumSha256: createHash('sha256').update(readFileSync(join(directory, filename))).digest('hex'),
    }));
  if (migrations.length === 0) throw new Error('BailingHub Core artifact has no official migrations');
  const retiredMigrations = BAILINGHUB_RETIRED_CORE_MIGRATIONS_V1;
  const activeFilenames = new Set(migrations.map((item) => item.filename));
  if (retiredMigrations.some((item) => activeFilenames.has(item.filename))) {
    throw new Error('BailingHub Core artifact active and retired migrations overlap');
  }
  const manifestSha256 = createHash('sha256')
    .update('bailinghub-core-artifact-v1')
    .update('\0')
    .update(version)
    .update('\0active\0')
    .update(migrations.map((item) => `${item.filename}\0${item.checksumSha256}`).join('\n'))
    .update('\0retired\0')
    .update(retiredMigrations.map((item) => (
      `${item.filename}\0${item.checksumSha256}\0${item.byteLength}\0${item.replay}`
    )).join('\n'))
    .digest('hex');
  return Object.freeze({
    packageName: 'bailinghub',
    version,
    latestMigration: migrations.at(-1)!.filename,
    migrations: Object.freeze(migrations),
    retiredMigrations,
    manifestSha256,
  });
}

/** Identity of the exact installed Core artifact; hosts must not duplicate it in configuration. */
export const BAILINGHUB_CORE_ARTIFACT_V1 = readArtifactManifest();
