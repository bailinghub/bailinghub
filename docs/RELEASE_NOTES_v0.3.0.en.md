# BailingHub v0.3.0: Composable Core and Kernel Host API v1

`v0.3.0` makes the same open-source BailingHub Core usable either as the existing standalone service or as a formally composed Kernel inside another host. An external product, managed platform, or deployment system can pin the public npm artifact and create and mount Kernels through `bailinghub/kernel-api/v1` without copying or forking Core routing, tools, jobs, messages, approvals, or audit behavior.

The startup path, console, and public HTTP contract for ordinary self-hosted deployments remain unchanged. This release adds a composition boundary; it does not move hosted multi-tenancy into the open-source Core.

## Main changes

- Added the stable `bailinghub/kernel-api/v1` export for Kernel construction, lifecycle, HTTP mounting, Core Schema migration, and exact artifact identity.
- One process may create multiple independent Kernel instances. The host must provide a separate state database, runtime directory, configuration, and request prefix for every instance, while retaining responsibility for tenant identity, authorization, plans, and lifecycle.
- HTTP mounting supports path prefixes without relying on one global singleton or a fixed root path. The standalone server now composes the same Kernel so hosted and standalone execution do not become separate implementations.
- The mount prefix also scopes built-in self-smoke requests. `runtimeRoot` takes over the historical default pause file, and Kernel shutdown destroys its own transient channel-credential caches.
- Once an `identityProvider` is injected, human accounts and password changes explicitly belong to the Host identity domain. Core no longer exposes or accepts local accounts that the Host login flow cannot use.
- Configuration, state, runtime, and route dependencies are exposed through narrow composition seams. Internal modules outside `kernel-api/v1` are not public extension contracts.
- The npm package includes the Kernel API, official SQL, console assets, and artifact-verification inputs. Release checks install the real `.tgz` and verify its stable exports.

## Official Schema Migrator

A host must not rely on Kernel startup to mutate a database implicitly. Deployment and upgrade orchestration calls the official migrator explicitly and starts or resumes traffic only after it succeeds.

The migration ledger now includes `checksum_sha256`:

- a fresh Schema executes only the current 49 active migrations and records each digest;
- an existing deployment safely backfills digests without replaying recorded SQL;
- three early-deployment records, `020_provider_sign_version.sql`, `021_drop_provider_sign_version.sql`, and `037_route_tools_shape.sql`, are preserved as retired evidence with `replay: never`; old ledgers can recognize and backfill their original digests, while fresh Schemas never execute or insert them;
- any published-migration digest drift or ledger filename unknown to the installed artifact fails closed before digest backfill or new migration execution.

This release adds no business table or business column. A standalone upgrade still runs:

```bash
npm run db:init
# restart BailingHub only after it succeeds
```

Digest-backfill messages are expected on the first run with a legacy ledger. Do not delete historical ledger rows or restore retired SQL files to `sql/`.

## Exact artifacts and host requirements

Production hosts should use an exact package version and lockfile rather than `latest`, a SemVer range, a Git branch, or a local link:

```bash
npm install --save-exact bailinghub@0.3.0
```

Before startup, verify the installed version and the lockfile's immutable HTTPS `.tgz` URL plus sha512 `integrity`. `BAILINGHUB_CORE_ARTIFACT_V1` exposes the version, active migrations, retired evidence, and aggregate digest for startup, provisioning, and fleet-upgrade checks.

## Compatibility and boundaries

- Standalone public pages, the Client API, chat protocol, Executor Protocol, tool signatures, approval semantics, and final business authorization are unchanged.
- ACC is unchanged. Ecosystem adapters continue to consume the existing Client API or Executor Protocol and do not need a package release solely because of the Kernel Host API.
- The Kernel Host API does not provide platform accounts, tenant directories, registration, billing, plans, or cross-tenant routing. Those remain host-product control-plane responsibilities.
- `kernel-api/v1` is the supported composition entry. Direct imports from `src/app`, `src/routes`, repository implementations, or other internal files are outside the compatibility commitment.
- Image publication now enforces an executable policy: prerelease tags can never update `latest`; stable tags may update the stable channel according to release configuration.

## Validation

```bash
npm run release:check
npm pack --dry-run
```

Focused coverage includes:

- standalone and hosted execution composing the same Kernel path;
- per-instance state, configuration, runtime-directory, and request-prefix isolation;
- Kernel start, drain, stop, and resource cleanup;
- fresh and legacy migration ledgers, digest backfill, retired evidence, and fail-closed unknown migrations;
- real npm tarball exports, assets, SQL, and artifact identity;
- prerelease images being unable to overwrite `latest`.

## Related documentation

- [Kernel Host API v1](KERNEL_HOST_API.en.md)
- [SQL migration discipline](../sql/README.en.md)
- [Architecture](ARCHITECTURE.en.md)
- [Compatibility and upgrades](COMPATIBILITY.en.md)
- [中文发布说明](RELEASE_NOTES_v0.3.0.md)
