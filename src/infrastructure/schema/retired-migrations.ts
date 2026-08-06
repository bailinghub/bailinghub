/**
 * Checksums for migrations that existed in pre-public deployments but are no
 * longer part of the active, replayable Core migration sequence.
 *
 * These records are compatibility evidence only. Never restore the SQL files
 * to sql/, and never execute them for a fresh schema.
 */
export interface BailingHubRetiredCoreMigrationV1 {
  readonly filename: string;
  readonly checksumSha256: string;
  readonly byteLength: number;
  readonly replay: 'never';
}

export const BAILINGHUB_RETIRED_CORE_MIGRATIONS_V1: readonly BailingHubRetiredCoreMigrationV1[] =
  Object.freeze([
    Object.freeze({
      filename: '020_provider_sign_version.sql',
      checksumSha256: '9b4ed1ca632a0dcca92a768671584cbc29d09a4d6501697631d355616f15a21e',
      byteLength: 564,
      replay: 'never' as const,
    }),
    Object.freeze({
      filename: '021_drop_provider_sign_version.sql',
      checksumSha256: '513ba9dfe031e785da09d931405cbcf867f703b2b7a6d0ec7077719082206466',
      byteLength: 407,
      replay: 'never' as const,
    }),
    Object.freeze({
      filename: '037_route_tools_shape.sql',
      checksumSha256: 'da87330abb088868827445a425e30bc6928b8ee47d4aeb680784fcf8d0a11fb4',
      byteLength: 1181,
      replay: 'never' as const,
    }),
  ]);
