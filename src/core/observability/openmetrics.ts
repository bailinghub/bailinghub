import { JOB_STATUSES, TERMINAL_JOB_STATUSES } from '../contracts/types';
import type { JobOperationalMetricsSnapshot } from '../state/state-contracts';
import { NOTIFICATION_STATUSES, type NotificationSnapshot } from '../contracts/notification-outbox';

export interface ControlPlaneOperationalMetricsSnapshot {
  pendingApprovals: number;
  executorsOnline: number;
  executorsOffline: number;
}

export interface CollectorResult<T> {
  available: boolean;
  success: boolean;
  value?: T;
}

export interface BackgroundWorkMetricsSnapshot {
  draining?: boolean;
  drainTimeouts?: number;
  kinds: Array<{ kind: string; inFlight: number; completed: number; failed: number; oldestPendingAgeMs: number;
    lastStartedAt: string | null; lastCompletedAt: string | null; lastFailedAt: string | null }>;
}

export interface RuntimeMaintenanceMetricsSnapshot {
  capturedAtMs: number;
  usage?: BackgroundWorkMetricsSnapshot;
  notification?: BackgroundWorkMetricsSnapshot;
  approval?: BackgroundWorkMetricsSnapshot;
  usageReconciliation?: { scanned: number; settled: number; deferred: number; failed: number; hasMore: boolean };
  approvalReconciliation?: { scanned: number; completed: number; pending: number; failed: number };
  usageRetry?: { running: boolean; consecutiveFailures: number; retryAfterMs: number };
  notificationOutbox?: Array<{ source: 'jobs' | 'approvals'; available: boolean; snapshot?: NotificationSnapshot }>;
}

export interface OperationalMetricsDocument {
  version: string;
  commit: string;
  paused: boolean;
  queue: { running: number; waiting: number };
  state: CollectorResult<JobOperationalMetricsSnapshot>;
  controlPlane: CollectorResult<ControlPlaneOperationalMetricsSnapshot>;
  maintenance?: CollectorResult<RuntimeMaintenanceMetricsSnapshot>;
  auditWriteFailuresTotal: number;
  scrapeDurationSeconds: number;
}

function labelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function family(lines: string[], name: string, help: string, type: 'counter' | 'gauge', samples: string[]): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
  lines.push(...samples);
}

// Never render a caller-supplied kind, phase, status or source as a label.
const BACKGROUND_KINDS = {
  usage: ['model-completion', 'settlement', 'response-cleanup', 'usage-reconciliation', 'reference-price-refresh'],
  notification: ['callback', 'delivery', 'approval-notification', 'alert', 'delivery-dlq'],
  approval: ['approval-continuation'],
} as const;

function renderMaintenance(lines: string[], snapshot: RuntimeMaintenanceMetricsSnapshot): void {
  const flight: string[] = [], oldest: string[] = [], finished: string[] = [], timestamps: string[] = [], ages: string[] = [];
  const draining: string[] = [], timeouts: string[] = [];
  for (const source of ['usage', 'notification', 'approval'] as const) {
    const value = snapshot[source];
    if (!value) continue;
    if (value.draining !== undefined) draining.push(`bailinghub_background_draining{source="${source}"} ${value.draining ? 1 : 0}`);
    if (value.drainTimeouts !== undefined) timeouts.push(`bailinghub_background_drain_timeouts_total{source="${source}"} ${finite(value.drainTimeouts)}`);
    for (const kind of BACKGROUND_KINDS[source]) {
      const work = value.kinds.find(row => row.kind === kind);
      if (!work) continue;
      const labels = `source="${source}",kind="${kind}"`;
      flight.push(`bailinghub_background_work_in_flight{${labels}} ${finite(work.inFlight)}`);
      oldest.push(`bailinghub_background_work_oldest_pending_age_seconds{${labels}} ${finite(work.oldestPendingAgeMs) / 1000}`);
      for (const outcome of ['completed', 'failed'] as const) {
        finished.push(`bailinghub_background_work_finished_total{${labels},outcome="${outcome}"} ${finite(work[outcome])}`);
      }
      for (const phase of ['started', 'completed', 'failed'] as const) {
        const at = work[phase === 'started' ? 'lastStartedAt' : phase === 'completed' ? 'lastCompletedAt' : 'lastFailedAt'];
        const epoch = at === null ? NaN : Date.parse(at);
        timestamps.push(`bailinghub_background_work_last_run_timestamp_seconds{${labels},phase="${phase}"} ${Number.isFinite(epoch) ? epoch / 1000 : 0}`);
        // Missing history is explicit as timestamp=0; do not invent an age of zero.
        if (Number.isFinite(epoch)) ages.push(`bailinghub_background_work_last_run_age_seconds{${labels},phase="${phase}"} ${Math.max(0, finite(snapshot.capturedAtMs - epoch)) / 1000}`);
      }
    }
  }
  const groups: Array<[string, string, 'counter' | 'gauge', string[]]> = [
    ['bailinghub_background_work_in_flight', 'Accepted process-local continuations currently in flight.', 'gauge', flight],
    ['bailinghub_background_work_oldest_pending_age_seconds', 'Age of the oldest accepted process-local continuation.', 'gauge', oldest],
    ['bailinghub_background_work_finished_total', 'Process-local continuation outcomes, not recipient delivery acknowledgements.', 'counter', finished],
    ['bailinghub_background_work_last_run_timestamp_seconds', 'Last observed start or completion time; zero means never observed.', 'gauge', timestamps],
    ['bailinghub_background_work_last_run_age_seconds', 'Age since the last observed start or completion, omitted when never observed.', 'gauge', ages],
    ['bailinghub_background_draining', 'Whether an owning background tracker has stopped new maintenance admission.', 'gauge', draining],
    ['bailinghub_background_drain_timeouts_total', 'Process-local background drain calls that exhausted their budget.', 'counter', timeouts],
  ];
  for (const [name, help, type, samples] of groups) if (samples.length) family(lines, name, help, type, samples);

  const progress: string[] = [];
  if (snapshot.notificationOutbox) {
    const availability: string[] = [], records: string[] = [], pendingAge: string[] = [], expired: string[] = [];
    for (const source of ['jobs', 'approvals'] as const) {
      const row = snapshot.notificationOutbox.find(item => item.source === source);
      availability.push(`bailinghub_notification_outbox_available{source="${source}"} ${row?.available ? 1 : 0}`);
      if (!row?.snapshot) continue;
      for (const status of NOTIFICATION_STATUSES) records.push(`bailinghub_notification_outbox_records{source="${source}",status="${status}"} ${finite(row.snapshot.counts[status])}`);
      pendingAge.push(`bailinghub_notification_outbox_oldest_pending_age_seconds{source="${source}"} ${finite(row.snapshot.oldestPendingAgeSeconds)}`);
      expired.push(`bailinghub_notification_outbox_expired_leases{source="${source}"} ${finite(row.snapshot.expiredLeases)}`);
    }
    family(lines, 'bailinghub_notification_outbox_available', 'Availability of atomic notification intent persistence for built-in sources.', 'gauge', availability);
    if (records.length) family(lines, 'bailinghub_notification_outbox_records', 'Persisted notification intents by state; completed includes durable queue handoff and is not a human receipt.', 'gauge', records);
    if (pendingAge.length) family(lines, 'bailinghub_notification_outbox_oldest_pending_age_seconds', 'Age of the oldest pending or processing notification intent.', 'gauge', pendingAge);
    if (expired.length) family(lines, 'bailinghub_notification_outbox_expired_leases', 'Expired notification leases awaiting recovery or uncertainty classification.', 'gauge', expired);
  }
  if (snapshot.usageReconciliation) {
    for (const outcome of ['scanned', 'settled', 'deferred', 'failed'] as const) {
      progress.push(`bailinghub_maintenance_last_page_records{kind="usage-reconciliation",outcome="${outcome}"} ${finite(snapshot.usageReconciliation[outcome])}`);
    }
    family(lines, 'bailinghub_maintenance_last_page_has_more', 'Whether the last usage reconciliation page reached its bounded scan size.', 'gauge', [
      `bailinghub_maintenance_last_page_has_more{kind="usage-reconciliation"} ${snapshot.usageReconciliation.hasMore ? 1 : 0}`,
    ]);
  }
  if (snapshot.approvalReconciliation) {
    for (const outcome of ['scanned', 'completed', 'pending', 'failed'] as const) {
      progress.push(`bailinghub_maintenance_last_page_records{kind="approval-continuation",outcome="${outcome}"} ${finite(snapshot.approvalReconciliation[outcome])}`);
    }
  }
  if (progress.length) family(lines, 'bailinghub_maintenance_last_page_records', 'Aggregate records processed in the latest/current bounded maintenance page, not total persisted backlog.', 'gauge', progress);
  if (snapshot.usageRetry) {
    family(lines, 'bailinghub_usage_maintenance_consecutive_failures', 'Current bounded usage maintenance failure backoff count.', 'gauge', [
      `bailinghub_usage_maintenance_consecutive_failures ${finite(snapshot.usageRetry.consecutiveFailures)}`,
    ]);
    family(lines, 'bailinghub_usage_maintenance_retry_after_seconds', 'Seconds until the current usage maintenance retry backoff expires.', 'gauge', [
      `bailinghub_usage_maintenance_retry_after_seconds ${finite(snapshot.usageRetry.retryAfterMs) / 1000}`,
    ]);
  }
}

/** Render only fixed, low-cardinality labels. Job, tenant, principal and argument data never enter this document. */
export function renderOperationalMetrics(document: OperationalMetricsDocument): string {
  const lines: string[] = [];
  family(lines, 'bailinghub_info', 'BailingHub build information.', 'gauge', [
    `bailinghub_info{version="${labelValue(document.version)}",commit="${labelValue(document.commit)}"} 1`,
  ]);
  family(lines, 'bailinghub_up', 'Whether the BailingHub metrics endpoint is serving.', 'gauge', ['bailinghub_up 1']);
  family(lines, 'bailinghub_runtime_paused', 'Whether the global runtime kill switch is active.', 'gauge', [
    `bailinghub_runtime_paused ${document.paused ? 1 : 0}`,
  ]);
  family(lines, 'bailinghub_runtime_queue', 'In-process runtime queue depth by state.', 'gauge', [
    `bailinghub_runtime_queue{state="running"} ${finite(document.queue.running)}`,
    `bailinghub_runtime_queue{state="waiting"} ${finite(document.queue.waiting)}`,
  ]);
  family(lines, 'bailinghub_metrics_collector_available', 'Whether an optional metrics collector is implemented.', 'gauge', [
    `bailinghub_metrics_collector_available{collector="state"} ${document.state.available ? 1 : 0}`,
    `bailinghub_metrics_collector_available{collector="control_plane"} ${document.controlPlane.available ? 1 : 0}`,
    `bailinghub_metrics_collector_available{collector="maintenance"} ${document.maintenance?.available ? 1 : 0}`,
  ]);
  family(lines, 'bailinghub_metrics_collector_success', 'Whether an optional collector succeeded during this scrape.', 'gauge', [
    `bailinghub_metrics_collector_success{collector="state"} ${document.state.success ? 1 : 0}`,
    `bailinghub_metrics_collector_success{collector="control_plane"} ${document.controlPlane.success ? 1 : 0}`,
    `bailinghub_metrics_collector_success{collector="maintenance"} ${document.maintenance?.success ? 1 : 0}`,
  ]);

  if (document.state.value) {
    const state = document.state.value;
    family(lines, 'bailinghub_job_records', 'Current job records by lifecycle status.', 'gauge',
      JOB_STATUSES.map((status) => `bailinghub_job_records{status="${status}"} ${finite(state.byStatus[status])}`));
    family(lines, 'bailinghub_jobs_terminal_15m', 'Jobs entering a terminal status during the last 15 minutes.', 'gauge',
      TERMINAL_JOB_STATUSES.map((status) => `bailinghub_jobs_terminal_15m{status="${status}"} ${finite(state.terminalLast15m[status])}`));
    family(lines, 'bailinghub_queue_oldest_queued_age_seconds', 'Age of the oldest non-monitor queued job.', 'gauge', [
      `bailinghub_queue_oldest_queued_age_seconds ${finite(state.oldestQueuedAgeSeconds)}`,
    ]);
    family(lines, 'bailinghub_queue_delayed_jobs', 'Queued jobs whose run_after time is still in the future.', 'gauge', [
      `bailinghub_queue_delayed_jobs ${finite(state.delayedQueuedJobs)}`,
    ]);
    family(lines, 'bailinghub_jobs_expired_leases', 'Running or dispatched jobs with an explicitly expired lease.', 'gauge', [
      `bailinghub_jobs_expired_leases ${finite(state.expiredLeases)}`,
    ]);
    family(lines, 'bailinghub_threads_blocked', 'Conversation threads with queued work blocked by in-flight work.', 'gauge', [
      `bailinghub_threads_blocked ${finite(state.blockedThreads)}`,
    ]);
  }

  if (document.controlPlane.value) {
    const control = document.controlPlane.value;
    family(lines, 'bailinghub_approvals_pending', 'Tool approvals currently awaiting a decision.', 'gauge', [
      `bailinghub_approvals_pending ${finite(control.pendingApprovals)}`,
    ]);
    family(lines, 'bailinghub_executors', 'Registered executors by heartbeat state.', 'gauge', [
      `bailinghub_executors{state="online"} ${finite(control.executorsOnline)}`,
      `bailinghub_executors{state="offline"} ${finite(control.executorsOffline)}`,
    ]);
  }

  if (document.maintenance?.value) renderMaintenance(lines, document.maintenance.value);

  family(lines, 'bailinghub_audit_write_failures_total', 'Audit ledger write failures observed by this process.', 'counter', [
    `bailinghub_audit_write_failures_total ${finite(document.auditWriteFailuresTotal)}`,
  ]);
  family(lines, 'bailinghub_metrics_scrape_duration_seconds', 'Time spent collecting and rendering this metrics document.', 'gauge', [
    `bailinghub_metrics_scrape_duration_seconds ${finite(document.scrapeDurationSeconds)}`,
  ]);
  lines.push('# EOF');
  return lines.join('\n') + '\n';
}
