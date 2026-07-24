# BailingHub v0.1.9: Optional OpenMetrics Operational Metrics

`v0.1.9` adds a disabled-by-default OpenMetrics endpoint with independent authentication for self-hosted deployments. It turns queue pressure, executor liveness, approval waits, expired leases, and audit-write failures into stable, low-cardinality metrics that Prometheus-compatible collectors can scrape without parsing logs or reading business payloads.

## Why this matters

Logs are useful for investigating an event, and traces are useful for following one execution path. Production operations also need continuous answers to a different set of questions:

- How many jobs are queued, running, waiting for approval, or failed?
- How long has the oldest queued job waited?
- Are there delayed jobs, expired leases, or blocked threads?
- Are executors online?
- Are audit writes failing?
- Is the runtime paused, and are the metrics collectors themselves healthy?

These signals should come from bounded state and control-plane aggregation, not from log bodies, job arguments, or business data.

## Main changes

### Disabled by default and independently authenticated

Enable the endpoint with:

```text
BAILING_METRICS_ENABLED=true
BAILING_METRICS_TOKEN=<independent random token of at least 24 characters>
BAILING_METRICS_SCRAPE_TIMEOUT_MS=5000
```

The security contract is:

- `/metrics` is not exposed by default;
- when enabled, it requires `Authorization: Bearer <token>`;
- query-string tokens are not accepted;
- the metrics token cannot reuse the administrative root token;
- missing, short, or reused tokens cause configuration validation to fail.

Generate an independent token with:

```bash
openssl rand -hex 32
```

### Stable, low-cardinality metrics

The endpoint exposes only fixed states and bounded classifications, including:

- current job-state counts;
- recent terminal outcomes;
- oldest queued-job age;
- delayed jobs, expired leases, and blocked threads;
- pending approvals;
- executor online, offline, and stale-heartbeat states;
- audit-write failures;
- runtime pause state;
- state-store and control-plane collector health.

Metrics never include job IDs, tenants, principals, routes, arguments, prompts, response bodies, or business payloads as labels.

### Collector fault isolation

State-store and control-plane collection run independently with bounded timeouts. If one collector fails:

- remaining metrics are still returned;
- the corresponding collector-health metric reports failure;
- missing business state is not fabricated as zero;
- collection failure does not change job execution, approval, or audit behavior.

### Database indexes

This release adds:

```text
sql/050_operational_metrics_indexes.sql
```

The migration only adds indexes for terminal-window and executor-heartbeat aggregation. It does not change existing columns or business semantics.

Official Docker images run `npm run db:init` during startup. Existing deployments that run directly from source, use a custom startup command, or bypass the official entrypoint must run this before starting the upgraded service:

```bash
npm run db:init
```

## Scrape example

```bash
curl -fsS \
  -H "Authorization: Bearer $BAILING_METRICS_TOKEN" \
  http://127.0.0.1:18900/metrics
```

Do not place the metrics token in URLs, public configuration, screenshots, or logs.

## Compatibility boundary

- `/metrics` is disabled by default, so deployments that do not enable it retain existing public behavior.
- The Client API, executor protocol, tool signatures, chat protocol, and ACC semantics are unchanged.
- New state aggregation and control-plane metrics methods are optional extensions; existing third-party implementations may omit them.
- Metrics are operational observations, not authorization decisions, approval evidence, or final business authority.

## Validation

The release is validated with:

```bash
npm run typecheck
npm test
npm run docs:check
npm run security:scan
npm run release:check
```

After deployment, verify that:

1. `npm run db:init` completes and the migration ledger includes `050_operational_metrics_indexes.sql`;
2. `/health/ready` reports ready;
3. `/metrics` is unavailable while disabled;
4. missing or incorrect tokens are rejected when enabled;
5. the correct token returns OpenMetrics text;
6. output contains no job IDs, principals, arguments, or business payloads.

## Related documentation

- [Production operations](OPERATIONS.en.md)
- [Compatibility and upgrade policy](COMPATIBILITY.en.md)
- [Changelog](CHANGELOG.en.md)
