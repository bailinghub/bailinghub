# sql/ - Hub State Database Schema

This directory contains the MySQL DDL for the independent BailingHub state database. Tables use the `bz_` prefix. The default database name is `bailinghub`.

Run migrations with:

```bash
npm run db:init
```

## Migration Ledger

`scripts/init-db.ts` records applied migration file names in `bz_schema_migrations`.

Applied files are skipped and never replayed. This makes one-time schema actions safe after they have been recorded.

A small immutable catalog records the filename, original byte checksum, and length of migrations that appeared only in early deployment ledgers and have since retired from the active SQL sequence. Existing ledger rows may receive a missing checksum from that catalog, but a fresh schema neither executes nor records retired migrations. Their SQL files must not be restored to this directory. Unknown ledger history and checksum mismatches fail closed before any new migration runs.

Duplicate-column or duplicate-index errors are tolerated only when the live object exactly matches the official `ADD COLUMN` or `ADD INDEX` statement. Other SQL errors remain fatal.

## Unreleased candidate: 059 authorization subject display

`059_agent_subject_display.sql` adds one nullable JSON column named `subject_display`,
with a NULL default, to each of `bz_agent_authorizations` and `bz_agent_sessions`.
Existing rows stay NULL (name pending sync); device names, local aliases and identity
values are not used to invent names. No principal, scope, credential, Session or
archive record is rewritten. Business backends can later name the original session
through the [authorization name API](../docs/AGENT_SUBJECT_DISPLAY.en.md).

Explicitly apply 059 through the existing migration entry point before starting this
candidate runtime. Custom Hosts must package the official SQL and implement the optional
display-update repository method. An older Host explicitly reports unavailable for
new naming operations while accepting the original approval request without a name.
These candidate files do not indicate that a deployment or migration has occurred.

## Migration Rules

Schema files are part of the deployment safety boundary.

1. Always add a new numbered `.sql` file. Do not edit already released migration files.
2. Prefer additive, idempotent changes:
   - `CREATE TABLE IF NOT EXISTS`;
   - `ALTER TABLE ... ADD COLUMN ... DEFAULT ...`;
   - add indexes in an idempotent way;
   - use `INSERT IGNORE` or `INSERT ... ON DUPLICATE KEY UPDATE` for seed data.
3. Avoid destructive operations:
   - no `DROP COLUMN`;
   - no `DROP TABLE`;
   - no `RENAME`;
   - no column type rewrite in minor releases.

For incompatible changes, use a transition window and document the upgrade path.

## Naming

Use `NNN_short_description.sql` with three-digit increasing numbers. Gaps are allowed. New files should use the current maximum number plus one.
