# Model request process-crash and lost-acknowledgement regressions

[简体中文](MODEL_PROCESS_RECOVERY.md)

This page describes additional tests included in Core 0.9.2. The historical `v0.9.1` Tag contains original-request recovery and usage shutdown draining, but not these new process tests. Source, executed checks, released artifacts and production acceptance remain separate evidence.

## Fault windows

Two distinct Kernel child-process PIDs use the same synthetic schema in a dedicated MySQL instance and an independent synthetic provider. The suite covers admission and dispatch transaction boundaries; a received provider request without a response; a received response without a committed result; a committed result awaiting settlement; and a saved chat result whose HTTP delivery is lost. A protocol proxy also withholds the actual MySQL COMMIT OK packet after committed dispatch, result and settlement transactions.

The first process receives a real `SIGKILL`. The replacement process is checked for original operation/request identity, physical provider calls, preserved result/hash, ledger rows and consumed USD. Reading a saved result must not call the provider again, and settlement recovery must not charge twice. An unknown result after durable dispatch retains its original ID for inspection; a network error is not permission to create another generation.

A killed admission that never committed and a durable admitted request are different cases. An admitted request that was not dispatched is not automatically dispatched after restart and can be cancelled under its original identity. Recovery may retain pending/unknown records; the suite does not require every record to become settled automatically.

## Run

Node.js 22 or newer and Docker are required. Pull the pinned public fixture image, then explicitly enable the suite:

```bash
docker pull mysql:8.4@sha256:85b9bf2e29cf836ecb8c2a15a935d4ba0c606631dff1dd79531a11983c638f2a
BAILING_USAGE_PROCESS_CRASH_TEST=1 npm run test:model-process-recovery
```

Without the flag the tests explicitly skip and create no Docker, database or child-process resources. With the flag enabled, missing Docker or the pinned image fails rather than silently skipping. A default test run is not evidence that this suite executed.

The suite creates its own labelled container, randomly publishes MySQL only on `127.0.0.1`, and creates a random schema per case. It does not load deployment configuration, inherit deployment database settings or use real model credentials. Cleanup checks the saved full container ID and ownership label and removes only owned processes, container and temporary data. Fault barriers and the protocol proxy are test facilities, not deployment tools.

## Limits

The suite does not establish real-provider retry/billing behavior, host power-loss recovery, database failover, cross-region resilience or exactly-once external business effects. It is not a production database-restore exercise. Hosted instance ownership and tenant isolation, and client task/delivery behavior, require their own checks.

[Tests](../src/app/kernel-model-process-crash.mysql.test.ts) · [Isolated child entrypoint](../src/test-support/model-process-crash-child.ts) · [Invocation receipts](INVOCATION_RECEIPTS.md) · [Implementation and public evidence index](IMPLEMENTATION_STATUS.en.md)
