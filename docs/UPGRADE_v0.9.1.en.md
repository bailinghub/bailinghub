# Core v0.9.1 patch upgrade guide

[中文版](UPGRADE_v0.9.1.md)

Upgrade public Core 0.9.0 to 0.9.1 to include usage background work in shutdown drain and receive the public capability index and general security-governance updates. There are no new APIs, SQL migrations, plan rules, or client features. MCP / Agent Client SDK and DSH remain at their existing 0.7.0 versions.

## Preserve data and original calls

Retain databases, instance configuration/credentials, attachment storage, previous artifacts, and host session/original-call records. Stop new work for the target instance, coordinate writers sharing its state, and reconcile dispatched requests. Do not replace recovery with a new `operation_id`.

The 0.9.0 `close()` did not explicitly drain usage background continuations. A finished old-version HTTP request or a returned old `close()` does not establish that image completion, settlement, or price persistence has finished. Reconcile in-flight work using original requests before replacing artifacts.

## Versions and database

- Use formal `v0.9.1` source, npm packages, or images. Verify the actual version, source Tag/commit, and artifact digest. Installer and prebuilt-image Compose defaults are updated to 0.9.1.
- Compared with 0.9.0, there are no new migrations, changes to existing SQL, table clears, or required plan/allowance resets. Earlier versions still apply all outstanding files through the official migrator; see the [0.9.0 upgrade guide](UPGRADE_v0.9.0.en.md).
- Embedded hosts recheck the complete `BAILINGHUB_CORE_ARTIFACT_V1` manifest. A version change changes artifact identity even when active SQL filenames/checksums are unchanged. Comparing only the latest migration is insufficient.
- This patch does not require SDK/DSH version bumps or changes to business declarations, signatures, permissions, or approvals.

## Shutdown and acceptance

For an ordinary deployment, check `/health`, the console, and existing business smoke paths. Deployments using the usage gateway also check original request results, billing states, and allowance. A complete result is not necessarily settled billing.

Embedded hosts continue fair `tick()` calls and use `close(drainMs)` for eviction, upgrades, and shutdown. Within the original budget, 0.9.1 waits for model completion, settlement, cleanup/reconciliation, and price refresh. A **usage-drain-stage timeout** retains the original dependencies and closing state. Wait for original work and retry on the same instance or alert; do not forcibly close its database or treat timeout as permission to redispatch. This does not imply that every subsequent resource-close failure leaves all resources untouched.

Public regressions can be reproduced in a dedicated test environment:

```bash
node --import tsx --test src/modules/usage/background-work.test.ts
BAILING_USAGE_TEST_MYSQL=1 node --import tsx --test src/app/kernel-usage-lifecycle.mysql.test.ts
```

The database cases use the fixture's isolated test MySQL, synthetic providers, and synthetic data. Without that environment, or when cases are skipped, record database validation as unexecuted. The cases need no live model calls and do not replace live-provider or deployment acceptance. See the [Kernel Host API](KERNEL_HOST_API.en.md) and [capability index](IMPLEMENTATION_STATUS.en.md) for coverage and limitations.

## Rollback boundary

No new schema is introduced, but returning to 0.9.0 removes the usage background-drain fix. Stop new work, retain original results, ledger, configuration, and rollback artifacts, and reconcile in-flight operations before deciding to roll back. Do not delete ledgers, replay original requests, or treat backup restoration as undoing later business effects.

[Release notes](RELEASE_NOTES_v0.9.1.en.md) · [Compatibility policy](COMPATIBILITY.en.md)
