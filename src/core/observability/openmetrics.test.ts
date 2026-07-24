import assert from 'node:assert/strict';
import test from 'node:test';
import { renderOperationalMetrics } from './openmetrics';

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
