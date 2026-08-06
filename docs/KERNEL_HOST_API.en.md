# Kernel Host API v1

`bailinghub/kernel-api/v1` is the versioned, high-level entry point for embedding a complete BailingHub Core in a trusted host. Normal single-organization deployments should keep using `npm start`; this API is for distributions that need host-owned process orchestration, identity integration, or multiple isolated Core instances.

The current Core npm artifact keeps TypeScript sources as its runtime entry points. A host must start through the `tsx` runtime installed with Core (for example, `tsx host.ts` or `node --import tsx host.mjs`); this is not a precompiled JavaScript library that plain Node.js can import without a loader. Production hosts should declare `tsx` as a direct runtime dependency instead of relying on transitive installation details.

## Boundary

- Each Kernel assembles the native configuration repositories, runtime ledger, HTTP routes, tool governance, and lifecycle. A host must not copy or replace the `bz_*` data plane.
- Every instance needs a separate MySQL schema and a distinct, non-empty absolute `runtimeRoot`. `instanceKey` must come from a trusted host directory, never directly from an end user.
- `identityProvider` may return only a human `admin/session` identity with explicit permissions. Once injected, human accounts and password changes belong to the Host identity domain; Core hides and disables its local account/password surfaces so a Host cannot create accounts that its own login flow will never accept. Core rejects Host-injected Client, Executor, or admin-token principals at runtime. Native Core credentials still verify Client tokens, Executor tokens, tool signatures, approvals, and final business authorization.
- `launchGuard` may add distribution policy before Core job creation, but it cannot bypass Core governance.
- `httpMountPath`, such as `/tenant/acme`, is a trusted same-origin prefix preserved by the console, widget, chat, media, callback URLs, and built-in self-smoke loopback.
- Hosts must import only this entry point, not `src/app/*`, default singletons, or other internal source paths.

## Lifecycle

```ts
import {
  createBailingHubKernel,
  loadConfig,
} from 'bailinghub/kernel-api/v1';

const config = loadConfig({ mode: 'kernel-host' });
// In Host mode config.root resolves to the installed Core artifact; consumer cwd is neither read nor trusted.
config.runtimeRoot = '/var/lib/my-host/acme';
// The historical root/.paused default is automatically rebased to runtimeRoot/.paused.
// An explicitly supplied custom killSwitchFile remains authoritative.
config.state.backend = 'mysql';
config.state.mysql = tenantScopedMysql;

const kernel = createBailingHubKernel({
  instanceKey: 'tenant:acme',
  config,
  schedulerMode: 'managed',
  httpMountPath: '/tenant/acme',
  bootstrapLocalAdmin: false,
  identityProvider,
});

await kernel.initialize();
await kernel.handle(req, res, trustedInnerUrl);
await kernel.tick(1);
await kernel.close(30_000);
```

Managed mode does not create a full timer set per Kernel. The host must call `tick()` fairly and call `close()` during eviction, upgrade, or process shutdown. The 0-600000 ms `close(drainMs)` budget covers initialization, in-flight maintenance/ticks, HTTP, InHub, and execution-queue drain; after drain, Core also clears Kernel-owned transient credential caches such as WeCom access tokens. A timeout preserves the original instance dependencies and reports an error, so the host can retry on that same instance or alert. New `initialize()` and `tick()` calls cannot reopen resources after closing begins.

Multiple Kernels may share `KernelExecutionQueueV1` as a process-wide concurrency ceiling. This v1 wrapper exposes only `run()` to the Host; admission, statistics, and drain for each Kernel-local queue remain Core-owned. All Kernels in one process currently need the same `display_tz` and `display_tz_label`.

## Artifact And Schema Upgrades

`BAILINGHUB_CORE_ARTIFACT_V1` identifies the installed package version, ordered active migration checksums, latest migration, retired-migration evidence, and aggregate manifest checksum. A host should persist these values in its instance directory and match all of them before loading a Kernel. `migrations` is the only sequence that may execute against a new schema. `retiredMigrations` only recognizes ledger history from early deployments; `replay: never` means the corresponding SQL must not be restored or replayed into a new database.

`migrateBailingHubCoreSchema()` is the explicit migration entry point. It executes only the installed Core artifact's `sql/*.sql`, uses an advisory lock and migration ledger, and detects historical migration drift with SHA-256. Existing retired-migration ledger rows may receive their checksum from the immutable evidence catalog, but they never enter the execution or fresh-schema ledger sequence. Any unknown history or checksum mismatch fails closed before a new migration runs. Kernel startup never runs DDL implicitly. A host must quiesce the target, drain every replica, migrate with a short-lived schema-only DDL identity, and restore traffic only after the new Kernel passes readiness.

## Out Of Scope

The Kernel Host API does not provide tenant signup, plans, billing, a platform console, cluster directories, database account management, or multi-replica upgrade orchestration. Those belong to an independent host or distribution and must not add product-specific branches to the open-source single-organization Core.
