import { JOB_STATUSES, TERMINAL_JOB_STATUSES } from '../contracts/types';
import type { JobOperationalMetricsSnapshot } from '../state/state-contracts';

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

export interface OperationalMetricsDocument {
  version: string;
  commit: string;
  paused: boolean;
  queue: { running: number; waiting: number };
  state: CollectorResult<JobOperationalMetricsSnapshot>;
  controlPlane: CollectorResult<ControlPlaneOperationalMetricsSnapshot>;
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
  ]);
  family(lines, 'bailinghub_metrics_collector_success', 'Whether an optional collector succeeded during this scrape.', 'gauge', [
    `bailinghub_metrics_collector_success{collector="state"} ${document.state.success ? 1 : 0}`,
    `bailinghub_metrics_collector_success{collector="control_plane"} ${document.controlPlane.success ? 1 : 0}`,
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

  family(lines, 'bailinghub_audit_write_failures_total', 'Audit ledger write failures observed by this process.', 'counter', [
    `bailinghub_audit_write_failures_total ${finite(document.auditWriteFailuresTotal)}`,
  ]);
  family(lines, 'bailinghub_metrics_scrape_duration_seconds', 'Time spent collecting and rendering this metrics document.', 'gauge', [
    `bailinghub_metrics_scrape_duration_seconds ${finite(document.scrapeDurationSeconds)}`,
  ]);
  lines.push('# EOF');
  return lines.join('\n') + '\n';
}
