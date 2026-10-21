# Offline, read-only upgrade planning

[中文](UPGRADE_PLAN.md)

`doctor --upgrade-plan` compares explicit source/target artifacts and a sanitized database snapshot. It never connects to a database, reads `.env` / `config.json`, starts Core, imports code from supplied artifacts, runs SQL, migrates, restores or modifies input files. Unlike `doctor --deployment`, it performs no HTTP probes. Missing evidence remains `incomplete`.

## Prepare artifacts and official manifests

Keep separate copies of the actual current artifact and the intended target. Verify their official tag/commit, npm package or image digest using release records first.

Existing releases expose `BAILINGHUB_CORE_ARTIFACT_V1` as a runtime object; they do **not** ship a pre-generated JSON manifest. From each trusted artifact root, with its runtime dependencies already installed, export the official object to a file outside the artifact:

```bash
node --import tsx --input-type=module -e 'import { BAILINGHUB_CORE_ARTIFACT_V1 } from "./src/kernel-api/v1/artifact.ts"; console.log(JSON.stringify(BAILINGHUB_CORE_ARTIFACT_V1, null, 2));' > /absolute/evidence/from-manifest.json
```

Repeat in the target root as `to-manifest.json`. This preparation command imports the trusted official manifest module; the planner itself never imports supplied artifacts or installs dependencies. Do not fabricate an old manifest with the current retired-migration list if the old artifact lacks this export.

The planner validates package name, exact version, complete SQL inventory, each active SQL digest and the v1 manifest digest from [Kernel Host API](KERNEL_HOST_API.md). It also validates migration filenames/numbers, retired evidence (`replay: never`), historical checksum continuity and SemVer direction, including prereleases. A different manifest under the same version blocks the plan. Historical active migrations cannot be silently retired, and retired migrations cannot return to the active SQL sequence. Retired checksum, byte length and `replay: never` evidence must remain unchanged, even when a replacement manifest is internally self-consistent.

A manifest covers version and migrations, **not whole-artifact authenticity**. An attacker could replace both SQL and its digest. `release_authenticity` always remains `not_verified`; verify trusted release provenance separately. Artifact file/directory symlinks and traversal filenames are rejected. No npm scripts from artifacts execute.

## Prepare a sanitized snapshot

There is no automatic database collector in this version. An operator uses existing authorized read-only connections to establish the effective state/configuration store topology and actual logical database identities. Example configuration files do not prove the effective deployment. Standard OSS MySQL commonly shares one database; hosts may separate stores, and JSONL state does not establish the absence of configuration MySQL.

Read each actual schema using existing tools:

```sql
SELECT DATABASE() AS database_name, @@server_uuid AS server_uuid;
SELECT COLUMN_NAME FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'bz_schema_migrations'
  AND COLUMN_NAME = 'checksum_sha256';
SELECT filename, checksum_sha256 FROM bz_schema_migrations ORDER BY filename;
```

For a legacy ledger without the checksum column, read only filenames and record `checksum_sha256: null`, `checksum_column: "absent"`. Never backfill or migrate to prepare a plan. A missing ledger table or insufficient access is not an empty complete ledger.

Avoid concurrent migration; capture a consistent read-only snapshot or document a write-stop window. Retain actual database identities privately. Assign a random 64-character lowercase hexadecimal ID to each confirmed logical database for this plan; reuse it for shared roles and use different IDs for distinct databases. `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'` generates only an opaque ID, not database evidence. Replicas/proxies require an operator to determine the actual logical schema. **These IDs are operator claims, not independent identity proofs.**

The JSON schema is:

| Field | Meaning |
| --- | --- |
| `schema` | `bailing.upgrade-snapshot.v1` |
| `captured_at` | Actual UTC capture time, e.g. `2026-10-21T04:00:00Z` |
| `source_manifest_sha256` | Exact digest from the actual current artifact's official manifest |
| `state` | `{ backend: "mysql" or "jsonl", database_id: ID or null }`; MySQL requires an ID |
| `configuration` | `{ backend: "mysql" or "file", database_id: ID or null }`; `file` means no database configuration repository, using local configuration files |
| `databases` | Exactly the 0–2 logical databases required by the two roles, one record each |
| `databases[].id` | The 64-character lowercase hex opaque identity used by the roles |
| `ledger_complete` | Boolean indicating whether all ledger rows were captured; partial snapshots produce no definitive pending list |
| `checksum_column` | `present` or `absent` |
| `rows` | Full array of `{ filename, checksum_sha256 }`; checksums are 64-character lowercase hex or `null` |

This deliberately **incomplete** JSONL + configuration MySQL example is not deployment evidence. Replace the time, source digest, identity and complete ledger before comparison:

```json
{
  "schema": "bailing.upgrade-snapshot.v1",
  "captured_at": "2026-10-21T04:00:00Z",
  "source_manifest_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "state": { "backend": "jsonl", "database_id": null },
  "configuration": {
    "backend": "mysql",
    "database_id": "1111111111111111111111111111111111111111111111111111111111111111"
  },
  "databases": [{
    "id": "1111111111111111111111111111111111111111111111111111111111111111",
    "ledger_complete": false,
    "checksum_column": "present",
    "rows": []
  }]
}
```

Never include passwords, connection strings, usernames, host addresses, business rows or raw SQL errors. Output contains only defined safe fields, without input paths or raw parsing errors. A recent timestamp does not prove freshness: recollect after any deployment, configuration or ledger change.

## Generate the plan

```bash
npm run --silent doctor -- --upgrade-plan \
  --from-artifact /absolute/core-current \
  --from-manifest /absolute/evidence/from-manifest.json \
  --to-artifact /absolute/core-target \
  --to-manifest /absolute/evidence/to-manifest.json \
  --snapshot /absolute/evidence/snapshot.json \
  --json > /absolute/evidence/upgrade-plan.json
```

`npm run --silent doctor:upgrade-plan -- ...` is equivalent. `--help` reads no inputs. No implicit paths, connection discovery or network targets are used. Missing arguments mean incomplete evidence; explicitly supplied unreadable/invalid files block the plan.

| Exit/result | Meaning |
| --- | --- |
| `0 / reviewable` | Supplied offline evidence is comparable without detected conflicts; **not deployment readiness or tested recovery** |
| `1 / blocked` | Artifact/digest/version/snapshot conflict or unknown migration; investigate before proceeding |
| `2 / incomplete` | Missing artifact, full ledger, database-role identity or legacy checksum evidence |
| `64 / invalid_arguments` | Unsupported/invalid arguments, including mixed deployment-diagnostics flags |

Shared MySQL produces one plan; separate stores are checked independently. Null legacy checksums remain incomplete without backfilling. Retired migrations never enter pending SQL. Missing source migrations are incomplete; records unknown to either source or target block the plan. Pending means the target active sequence minus a complete ledger snapshot, not proof of actual SQL tables/indexes.

## Execution remains separate

The plan lists artifact verification, consistent backups and isolated restore rehearsal, stopping intake and all writers, draining every replica, manual per-database migration, acceptance and rollback constraints. `npm run db:init` migrates only `state.mysql`; a separate configuration MySQL requires the official `migrateBailingHubCoreSchema({ mysql: configurationDatabase })` entry, once per distinct database and never concurrently.

It does not emit executable connection-bearing commands or authorize deployment. Preserve unknown business results, approvals, notifications, DLQ records and original IDs. Pending migrations unknown to the source manifest set `rollback_after_migration: blocked_by_old_manifest`; all other cases still require validation. Do not remove ledger records or assume old-tag switching is safe. Restoring a database cannot undo an external refund or message.

See the [0.9.4 upgrade/rollback guide](UPGRADE_v0.9.4.en.md), [operations](OPERATIONS.md) and [compatibility policy](COMPATIBILITY.en.md). Actual runtime identity, database identity, schema objects, backup restoration and cross-version business acceptance are unverified by this tool.

## Developer checks

```bash
npm run doctor:upgrade-plan:typecheck
npm run doctor:upgrade-plan:test
```

Both checks run in `release:check` and the basic CI job. Tests use synthetic artifacts/snapshots and compare the current official manifest format. They do not connect to databases or replace actual upgrade, recovery or production acceptance.
