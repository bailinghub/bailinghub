import assert from 'node:assert/strict';
import test from 'node:test';
import { renderOperationalMetrics } from './openmetrics';
import type { RuntimeMaintenanceMetricsSnapshot } from './openmetrics';

test('durable notification metrics expose fixed aggregates and distinguish an unavailable source', () => {
  const text = renderOperationalMetrics({ version: 'candidate', commit: 'candidate', paused: false,
    queue: { running: 0, waiting: 0 }, state: { available: false, success: false },
    controlPlane: { available: false, success: false }, auditWriteFailuresTotal: 0, scrapeDurationSeconds: 0,
    maintenance: { available: true, success: true, value: { capturedAtMs: 1,
      notificationOutbox: [ { source: 'jobs', available: true, snapshot: { counts: {
        pending: 3, processing: 1, completed: 7, skipped: 2, failed: 1, uncertain: 2,
        'secret-user-input': 100,
      } as any, oldestPendingAgeSeconds: 42, expiredLeases: 1 } },
      { source: 'approvals', available: false }, { source: 'secret-job-id', available: true } as any ],
    } },
  });
  assert.match(text, /bailinghub_notification_outbox_records\{source="jobs",status="pending"\} 3/);
  assert.match(text, /bailinghub_notification_outbox_available\{source="approvals"\} 0/);
  assert.match(text, /bailinghub_notification_outbox_oldest_pending_age_seconds\{source="jobs"\} 42/);
  assert.doesNotMatch(text, /notification_outbox_records\{source="approvals"|secret-user-input|secret-job-id/);
});

test('OpenMetrics renderer: emits fixed low-cardinality families and escapes build labels', () => {
  const text = renderOperationalMetrics({
    version: '0.1.8"test',
    commit: 'abc\\def\n',
    paused: false,
    queue: { running: 2, waiting: 3 },
    state: {
      available: true,
      success: true,
      value: {
        byStatus: { queued: 1, running: 2, dispatched: 3, done: 4, error: 5, rejected: 6 },
        terminalLast15m: { done: 4, error: 1, rejected: 0 },
        oldestQueuedAgeSeconds: 12.5,
        delayedQueuedJobs: 1,
        expiredLeases: 2,
        blockedThreads: 3,
      },
    },
    controlPlane: {
      available: true,
      success: true,
      value: { pendingApprovals: 7, executorsOnline: 8, executorsOffline: 9 },
    },
    auditWriteFailuresTotal: 10,
    scrapeDurationSeconds: 0.25,
  });

  assert.match(text, /bailinghub_info\{version="0\.1\.8\\"test",commit="abc\\\\def\\n"\} 1/);
  assert.match(text, /bailinghub_job_records\{status="queued"\} 1/);
  assert.match(text, /bailinghub_jobs_terminal_15m\{status="error"\} 1/);
  assert.match(text, /bailinghub_executors\{state="online"\} 8/);
  assert.match(text, /bailinghub_audit_write_failures_total 10/);
  assert.ok(text.endsWith('# EOF\n'));
  assert.doesNotMatch(text, /job_id|request_id|tenant|principal|args/);
});

test('OpenMetrics renderer: unavailable optional collectors are explicit and do not invent zero business data', () => {
  const text = renderOperationalMetrics({
    version: '0.1.8',
    commit: 'unknown',
    paused: true,
    queue: { running: 0, waiting: 0 },
    state: { available: false, success: false },
    controlPlane: { available: false, success: false },
    auditWriteFailuresTotal: 0,
    scrapeDurationSeconds: 0,
  });

  assert.match(text, /bailinghub_metrics_collector_available\{collector="state"\} 0/);
  assert.match(text, /bailinghub_metrics_collector_success\{collector="control_plane"\} 0/);
  assert.doesNotMatch(text, /bailinghub_job_records/);
  assert.doesNotMatch(text, /bailinghub_approvals_pending/);
});

test('maintenance renderer allows only fixed sources, kinds, phases and page outcomes', () => {
  const known = { kind: 'model-completion', inFlight: 2, completed: 4, failed: 1, oldestPendingAgeMs: 3000,
    lastStartedAt: new Date(1000).toISOString(), lastCompletedAt: null, lastFailedAt: new Date(2000).toISOString() };
  const snapshot: RuntimeMaintenanceMetricsSnapshot = {
    capturedAtMs: 5000,
    usage: { draining: true, drainTimeouts: 2, kinds: [known,
      { ...known, kind: 'PRIVATE_ACCOUNT_PROMPT_TOKEN_ROUTE' }] },
    usageReconciliation: { scanned: 50, settled: 1, deferred: 48, failed: 1, hasMore: true },
    approvalReconciliation: { scanned: 3, completed: 1, pending: 1, failed: 1 },
    usageRetry: { running: false, consecutiveFailures: 1, retryAfterMs: 2500 },
  };
  const text = renderOperationalMetrics({ version: 'test', commit: 'abc', paused: false, queue: { running: 0, waiting: 0 },
    state: { available: false, success: false }, controlPlane: { available: false, success: false },
    maintenance: { available: true, success: true, value: snapshot }, auditWriteFailuresTotal: 0, scrapeDurationSeconds: 0 });
  assert.match(text, /bailinghub_background_work_in_flight\{source="usage",kind="model-completion"\} 2/);
  assert.match(text, /bailinghub_background_work_oldest_pending_age_seconds\{source="usage",kind="model-completion"\} 3/);
  assert.match(text, /bailinghub_background_work_finished_total\{source="usage",kind="model-completion",outcome="failed"\} 1/);
  assert.match(text, /bailinghub_background_work_last_run_age_seconds\{source="usage",kind="model-completion",phase="started"\} 4/);
  assert.match(text, /bailinghub_background_work_last_run_timestamp_seconds\{source="usage",kind="model-completion",phase="completed"\} 0/);
  assert.doesNotMatch(text, /bailinghub_background_work_last_run_age_seconds[^\n]*phase="completed"/);
  assert.match(text, /bailinghub_background_drain_timeouts_total\{source="usage"\} 2/);
  assert.match(text, /bailinghub_maintenance_last_page_records\{kind="usage-reconciliation",outcome="failed"\} 1/);
  assert.match(text, /bailinghub_maintenance_last_page_records\{kind="approval-continuation",outcome="pending"\} 1/);
  assert.match(text, /bailinghub_usage_maintenance_retry_after_seconds 2\.5/);
  assert.doesNotMatch(text, /PRIVATE_ACCOUNT|PROMPT|TOKEN|ROUTE/);
});
