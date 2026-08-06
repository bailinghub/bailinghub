const OFFICIAL_MIGRATION_FILENAME = /^(\d{3})_[a-z0-9][a-z0-9_-]*\.sql$/;

/**
 * Runtime fail-closed validation for the migration artifact itself.
 * Release checks are useful evidence, but a host must not execute an
 * unclassified or duplicate-number SQL file merely because it ends in .sql.
 */
export function assertOfficialMigrationFilenames(filenames: readonly string[]): void {
  const invalid = filenames.filter((filename) => !OFFICIAL_MIGRATION_FILENAME.test(filename));
  if (invalid.length > 0) {
    throw new Error(`Core 官方迁移包含非规范文件：${invalid.sort().join(', ')}`);
  }

  const byNumber = new Map<string, string[]>();
  for (const filename of filenames) {
    const number = OFFICIAL_MIGRATION_FILENAME.exec(filename)![1]!;
    const group = byNumber.get(number) ?? [];
    group.push(filename);
    byNumber.set(number, group);
  }
  const duplicates = [...byNumber]
    .filter(([, files]) => files.length > 1)
    .map(([number, files]) => `${number}=[${files.sort().join(', ')}]`);
  if (duplicates.length > 0) {
    throw new Error(`Core 官方迁移编号重复：${duplicates.join('; ')}`);
  }
}
