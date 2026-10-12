# Read-only deployment diagnostics

Deployment diagnostics add a separate mode to `npm run doctor` for an installed Core. Doctor without arguments retains its source, documentation, example and OSS checks. Deployment mode checks the specified instance's public health and version declarations without running the existing check scripts.

See [DEPLOYMENT_DIAGNOSTICS.md](DEPLOYMENT_DIAGNOSTICS.md) for Chinese, [OPERATIONS.en.md](OPERATIONS.en.md) for deployment and recovery, and [IMPLEMENTATION_STATUS.en.md](IMPLEMENTATION_STATUS.en.md) for capability and evidence boundaries.

## Usage

Run from a Core checkout, source installation or unpacked npm artifact:

```bash
npm run --silent doctor -- --deployment --url http://127.0.0.1:18900 --json
```

The operator must provide an explicit URL; the tool does not discover targets from `.env`, `config.json` or smoke environment variables. A controlled Core mount prefix such as `https://hub.example.com/core` is supported but is not printed. URLs containing userinfo, query strings or fragments are rejected. The tool accepts no Token argument and performs no login.

The default mode sends only `GET /health` and `GET /version`. It does not connect to a database, read configuration contents, call a model, migrate, install, update, roll back, or control containers or services. It checks only whether `config.json` and `.env` exist. Missing files can indicate environment or host injection, so the effective configuration remains `unknown`. Credential safety is `not_checked`; no claim is made about default Tokens or connection strings.

For a container installation, run the same command from the installed Core directory inside the container, or use an externally unpacked Core artifact against the public URL. The tool does not run `docker inspect`, read container environments or infer a running image digest. Container startup, permissions and digest verification belong to the deployment procedure.

When the local directory is not the artifact to compare, supply a version and commit from a trusted release record:

```bash
npm run --silent doctor -- --deployment --url https://hub.example.com \
  --expect-version 0.9.1 --expect-commit f37df6042b390405a5f7b1630636d3017607db9f --json
```

Local identity comes from `package.json` and Git HEAD, falling back to the commit in `build-info.json` when Git is unavailable. By default, both local version and commit are compared; commit prefixes must contain at least 12 hexadecimal characters. A separate read-only Git check reports `clean`, `dirty` or `not_checked`, never filenames, with fsmonitor hooks and optional index writes disabled. A dirty or unavailable Git worktree keeps the default local-source comparison incomplete rather than treating uncommitted contents as the HEAD artifact.

Without usable local commit metadata, source remains `unknown` and the exit code is 2. Explicit expectations do not manufacture local source identity. Available public results are still reported; the deployment procedure must supply the missing artifact evidence.

Explicit expectations change the comparison target without claiming that another local artifact's SQL list matches the instance. Source evidence uses `local_metadata`; runtime evidence uses `reported_metadata`. Both keep `artifact_integrity: not_checked`. A clean worktree and matching version/commit establish consistent declarations, not artifact contents, signatures or digests. A real upgrade still requires an artifact manifest, integrity verification, backups and compatibility checks.

## Health, readiness and database identity

| Evidence | Default behavior | What it establishes |
|---|---|---|
| `/health` | Read | Instance response, pause flag and public application identity; a pause flag is not process death. |
| `/version` | Read | Declared application version, build commit and the latest packaged SQL filename and count. |
| `/health/ready` | `not_checked` | Read only with explicit `--readiness`; the server reads its database and migration ledger. |
| `/admin/api/version`, `/admin/api/status` | `not_checked`; no request | Protected state and applied migration details require separately authorized evidence. |

Opt in to readiness:

```bash
npm run --silent doctor -- --deployment --url http://127.0.0.1:18900 --readiness --json
```

This option causes the server to execute `SELECT 1` and read its migration ledger. It must not be described as having no database access. The tool itself still opens no direct database connection. `migrations.readiness` records only the public server summary, while `migrations.identity` remains `not_checked`. Zero pending migrations cannot prove the database identity, complete checksums or upgrade/downgrade compatibility. A JSONL backend that skips database checks remains `unknown` for this evidence.

A 401/403 response is recorded as `authentication_required` and `not_checked`. No authentication bypass or administrator endpoint request follows. Inconsistent health/version declarations, a mismatched expected commit, and a not-ready response are failures.

## JSON and exit codes

The report schema is `bailing.deployment-diagnostics.v1`, with source, runtime, comparison, configuration, database, migrations, protected_endpoints, upgrade, checks and request scope. Identity states distinguish `verified`, `mismatch`, `unknown` and `not_checked`. Verified means the corresponding declaration was obtained and compared; it is not cryptographic artifact certification or production adoption evidence.

| Exit code | Meaning |
|---|---|
| `0` | Selected checks passed. Configuration, direct database access, applied migration identity and protected endpoints may remain unchecked. |
| `1` | An observed failure, unreachable target, unexpected response, rejected URL or identity mismatch. |
| `2` | Incomplete evidence: no URL, missing version/commit, authentication required for a selected public endpoint, or skipped database readiness checks. |
| `64` | Invalid CLI arguments. |

`upgrade.state` is always `not_checked`. Exit 0 grants no automatic upgrade or rollback permission and does not replace pause, drain, backup, migration approval or acceptance. Core diagnostics report only the designated Core's public declarations. Host instance management and client task orchestration belong to their respective projects.

Each request defaults to 5000 ms, configurable with `--timeout-ms` from 100 to 30000. The deadline includes body reads, with a 64 KiB decoded response cap. All redirects are rejected, including same-origin redirects; retry using the final Core URL. Requests carry JSON Accept only, with no login Cookie, Authorization or configuration credentials. Output retains only fixed allowlisted fields and reason codes, excluding raw exceptions, response bodies, redirect locations and input credentials. Invalid URLs are not echoed.

Without `--json`, a short human-readable result is printed. Automation should use `npm run --silent` for clean JSON and check both the exit code and report scope. Deployment mode ignores `BAILING_DOCTOR_FULL`, `BAILING_DOCTOR_SMOKE`, and smoke URL/Token environment variables.

## Local validation

```bash
node --import tsx --test scripts/doctor-deployment.test.ts
```

Tests use temporary directories, loopback HTTP services and the existing public routes. They cover method/path restrictions, identity mismatch, authentication, readiness separation, deadlines, response caps, redirects and credential redaction. They do not connect to a real database, model or production service. Passing tests validate these diagnostic boundaries, not the acceptance of a target deployment.
