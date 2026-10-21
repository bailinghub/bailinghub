import type { SchemaReadinessCheck, SchemaReadinessDatabase } from '../../core/contracts/schema-readiness';
import { BAILINGHUB_CORE_ARTIFACT_V1 } from '../../kernel-api/v1/artifact';

const failedMigrations = (): SchemaReadinessCheck => ({ database: 'ok', pendingFilenames: [], migrations: { status: 'failed', pending: 0 } });

/** No DDL, checksum backfill or new connections. The installed artifact owns the inventory. */
export async function inspectCoreSchemaReadiness(database: SchemaReadinessDatabase): Promise<SchemaReadinessCheck> {
  try { await database.query('SELECT 1'); }
  catch { return { database: 'failed', pendingFilenames: [], migrations: { status: 'failed', pending: 0 } }; }
  try {
    const [payload] = await database.query('SELECT filename, checksum_sha256 FROM bz_schema_migrations ORDER BY filename');
    if (!Array.isArray(payload)) return failedMigrations();
    const artifact = BAILINGHUB_CORE_ARTIFACT_V1;
    const known = new Map([...artifact.migrations, ...artifact.retiredMigrations].map(file => [file.filename, file.checksumSha256]));
    const applied = new Set<string>();
    for (const row of payload) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return failedMigrations();
      const { filename, checksum_sha256: checksum } = row as Record<string, unknown>;
      if (typeof filename !== 'string' || applied.has(filename) || !known.has(filename)
        || typeof checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(checksum.trim())
        || checksum.trim().toLowerCase() !== known.get(filename)) return failedMigrations();
      applied.add(filename);
    }
    // Retired records are optional historical evidence, never pending work.
    const pendingFilenames = artifact.migrations.filter(file => !applied.has(file.filename)).map(file => file.filename);
    const pending = pendingFilenames.length;
    return { database: 'ok', pendingFilenames, migrations: { status: pending ? 'pending' : 'ok', pending } };
  } catch { return failedMigrations(); }
}
