# Production Operations Guide

This guide covers stable self-hosted operation of BailingHub: topology, readiness, capacity, upgrades, backups, and recovery. Use [DEMO.en.md](DEMO.en.md) for evaluation and [QUICKSTART.en.md](QUICKSTART.en.md) for the first installation.

## 1. Deployment Topology

For development and small pilots, run one BailingHub instance behind an HTTPS reverse proxy with MySQL. Jobs, leases, approvals, distributed rate limits, and audit records are persisted in MySQL. The in-process `Queue` only limits local concurrency; it is not the durable job queue.

For rolling upgrades and instance failover, run multiple identical BailingHub replicas behind a load balancer. Every replica must share the same MySQL database, security configuration, build version, and migration level. Use shared object storage for chat media in multi-replica deployments; local media storage is intended for a single instance.

Incremental chat events use a short process-local replay window by default. In a multi-replica deployment, route job creation and the SSE connection for the same `job_id` to one replica, or inject a shared `JobStreamBroker`. Without either, the canonical `done` result remains available from MySQL, but the client may not see incremental text.

```text
Business systems / channels
            |
     Load balancer / Ingress
            |
       +----+----+
       |         |
     Hub A     Hub B
       |         |
       +----+----+
            |
        Shared MySQL
            |
    Shared object storage
```

## 2. Health Endpoints

| Endpoint | Purpose | Failure action |
|---|---|---|
| `GET /health` | Liveness: the process responds | Restart the process |
| `GET /health/ready` | Readiness: MySQL is reachable and migrations are complete | Remove the instance from new traffic |

Readiness intentionally does not probe models, tool providers, or channels. A third-party outage must not remove the entire hub from the load balancer. Use system diagnostics and alert rules for those dependencies.

`/health` exposes the process-local `observability.audit_write_failures` counter and `last_audit_failure_at`. Any non-zero value should trigger an investigation of structured `audit_write_failed` runtime log events and database health. The counter resets on process restart and does not replace external monitoring. Security-critical audit remains fail-closed; best-effort callers may degrade, but their write failures still pass through this observer first.

```yaml
livenessProbe:
  httpGet: { path: /health, port: 18900 }
readinessProbe:
  httpGet: { path: /health/ready, port: 18900 }
```

## 3. Concurrency And Database Connections

- `concurrency` limits tasks running concurrently in one replica.
- `BAILING_MYSQL_CONNECTION_LIMIT` controls the pool size per replica; the default is 15.
- Approximate total connection budget as `replicas × pool size + migration and operator connections`.
- Do not size the system by HTTP QPS alone. Model latency, tool calls, job duration, and SSE connections materially change capacity.
- Disable reverse-proxy buffering for SSE and set the upstream read timeout above the maximum chat wait. BailingHub sends `X-Accel-Buffering: no`, but CDN and Ingress behavior must still be verified independently.

Measure queue depth, oldest queued age, success rate, P95/P99 duration, tool latency, MySQL connections and lock waits, CPU, memory, and event-loop delay. BailingHub does not publish an unverified universal QPS number; load-test with your actual task mix before making capacity commitments.

## 4. Upgrades

1. Back up MySQL.
2. Run `npm run release:check` outside production.
3. Run forward-only migrations from one deployment step. Do not let every replica migrate concurrently.
4. Start a new replica and wait for `/health/ready` to return 200.
5. Replace old replicas gradually while observing queue, errors, and lease recovery.

Migration state is recorded in `bz_schema_migrations`.

## 5. Backup And Recovery

Back up the complete MySQL database, object-storage media and knowledge-source files, and a secure copy of deployment configuration and external secrets. Use a consistent MySQL snapshot or `mysqldump --single-transaction`, and regularly perform restore drills.

Recovery order:

1. Stop traffic to all hub replicas.
2. Restore MySQL and shared object storage.
3. Start one build compatible with the restored migration level.
4. Verify readiness, diagnostics, and a representative trace.
5. Restore remaining replicas and traffic gradually.

## 6. Failure Semantics

- A hub crash during work is recovered through the database lease and reaper.
- Executor report failures are retried; unreported work is eventually recovered by lease expiry.
- Approval intents remain durable in MySQL.
- Tool and model failures are recorded in job trace; retry behavior depends on route policy and error type.
- Security-critical tool audit is fail-closed. Best-effort operational audit must still feed metrics and alerts.

## 7. Security Baseline

- Expose public traffic only through HTTPS.
- Use separate credentials for admins, callers, executors, and tool providers.
- Do not expose MySQL directly to the Internet.
- Rotate credentials and remove demo defaults in production.
- Keep API keys, database passwords, and sensitive payloads out of public errors, logs, and metric labels.

## 8. Go-Live Checklist

- `/health` and `/health/ready` return 200.
- Migration pending count is zero.
- System diagnostics report no configuration errors or expired leases.
- A real `/run`, tool call, trace, and result delivery have completed.
- Backup restoration has been verified.
- Alerts cover queue backlog, error rate, executor offline state, and delivery dead letters.
