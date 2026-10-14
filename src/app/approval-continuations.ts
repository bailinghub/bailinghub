import type { ApprovalContinuation } from '../core/contracts/approval-continuation';
import type { BackgroundWorkMetricsSnapshot } from '../core/observability/openmetrics';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ApprovalLedgerContract, ConfigStoreContract } from '../infrastructure/config/configstore';
import type { EngineRuntime } from './engine';
import { isAgentToolInvocationJob } from './agent-tool-job';

export interface ApprovalContinuationDeps {
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  engineRuntime: Pick<EngineRuntime, 'kickInhubScheduler'>;
  now: () => string;
  /** Host lifecycle owns stopping new maintenance and draining the awaited pass. */
  isClosing?: () => boolean;
}

export function supportsApprovalContinuations(deps: Pick<ApprovalContinuationDeps, 'configStore' | 'stateStore'>): boolean {
  const ledger = deps.configStore?.approvals;
  return Boolean(ledger?.decideWithContinuation && ledger.getContinuation && ledger.pendingContinuations
    && ledger.markContinuationAuditRecorded && ledger.completeContinuation && deps.stateStore.requeueApprovedJobOnce);
}

function checkedIntent(intent: ApprovalContinuation): void {
  if (intent.schema_version !== 'bailing.approval-continuation.v1'
    || !Number.isSafeInteger(intent.approval_id) || intent.approval_id <= 0
    || typeof intent.decision_key !== 'string' || !intent.decision_key || intent.decision_key.length > 160
    || !['approved', 'denied'].includes(intent.decision) || !['external', 'console'].includes(intent.source)
    || !['rerun', 'manual'].includes(intent.mode)) throw new Error('approval_continuation_invalid');
}

export async function continueApprovalDecisionFor(deps: ApprovalContinuationDeps, approvalId: number): Promise<{ rerun: boolean; pending: boolean }> {
  if (!supportsApprovalContinuations(deps)) throw new Error('approval_continuations_unavailable');
  const ledger = deps.configStore!.approvals;
  const intent = await ledger.getContinuation!(approvalId);
  // A historical decision has no new durable intent. Never infer or manufacture one.
  if (!intent || intent.completed) return { rerun: false, pending: false };
  checkedIntent(intent);
  const approval = await ledger.get(approvalId);
  if (!approval || approval.id !== intent.approval_id || approval.status !== intent.decision || approval.job_id !== intent.job_id
    || approval.request_id !== intent.request_id || approval.args_hash !== intent.args_hash
    || (approval.decision_id ?? null) !== (intent.decision_id ?? null)) throw new Error('approval_continuation_conflict');
  if (!intent.audit_recorded) {
    // Fixed identity makes a crash between append and acknowledgement recognizable.
    // Audit observations may repeat; original-job queue admission never does.
    await deps.stateStore.appendAudit({
      ts: deps.now(), job_id: intent.job_id, request_id: intent.request_id,
      event: intent.source === 'external'
        ? (intent.decision === 'approved' ? 'tool_approved_external' : 'tool_denied_external')
        : (intent.decision === 'approved' ? 'tool_approved' : 'tool_denied'),
      detail: {
        continuation_id: `approval:${intent.approval_id}:${intent.decision_key}`,
        approval_id: intent.approval_id, ...(intent.decision_id ? { decision_id: intent.decision_id } : {}),
        tool: intent.tool, scope: intent.scope, by: intent.by, auth: intent.auth,
        policy: intent.policy, reason: intent.reason, summary: intent.summary,
        ...(intent.comment ? { comment: intent.comment } : {}),
      },
    });
    await ledger.markContinuationAuditRecorded!(approvalId, intent.decision_key);
  }
  const latest = await ledger.get(approvalId);
  let rerun = false;
  if (intent.decision === 'approved' && intent.mode === 'rerun' && !latest?.used_at) {
    const job = await deps.stateStore.getJob(intent.job_id);
    if (!job || job.request_id !== intent.request_id || isAgentToolInvocationJob(job)) throw new Error('approval_continuation_job_conflict');
    const outcome = await deps.stateStore.requeueApprovedJobOnce!({
      job_id: intent.job_id, request_id: intent.request_id,
      approval_id: intent.approval_id, decision_key: intent.decision_key,
      decision_id: intent.decision_id,
      isApprovedUnused: async () => {
        const current = await ledger.get(approvalId);
        if (!current || current.status !== 'approved' || current.job_id !== intent.job_id || current.request_id !== intent.request_id
          || (current.decision_id ?? null) !== (intent.decision_id ?? null)) throw new Error('approval_continuation_conflict');
        return !current.used_at;
      },
    });
    if (outcome === 'in_flight') return { rerun: false, pending: true };
    if (outcome === 'missing' || outcome === 'conflict') throw new Error('approval_continuation_job_conflict');
    rerun = outcome === 'queued';
    // The queue is durable before waking the scheduler. Recovery can wake it again safely.
    if (outcome !== 'consumed') deps.engineRuntime.kickInhubScheduler();
  }
  await ledger.completeContinuation!(approvalId, intent.decision_key);
  return { rerun, pending: false };
}

const passes = new WeakMap<ApprovalLedgerContract, Promise<number>>();
export interface ApprovalContinuationProgress { scanned: number; completed: number; pending: number; failed: number }
interface PassMetrics {
  completed: number; failed: number; startedAt: string | null; completedAt: string | null; failedAt: string | null;
  progress: ApprovalContinuationProgress;
}
const passMetrics = new WeakMap<ApprovalLedgerContract, PassMetrics>();

/** Read process-local maintenance state; never enumerate approval/job records. */
export function approvalContinuationMaintenanceSnapshotFor(
  deps: Pick<ApprovalContinuationDeps, 'configStore' | 'stateStore'>,
  nowMs = Date.now(),
): { work: BackgroundWorkMetricsSnapshot; progress?: ApprovalContinuationProgress } | undefined {
  if (!supportsApprovalContinuations(deps)) return undefined;
  const ledger = deps.configStore!.approvals, value = passMetrics.get(ledger), running = passes.has(ledger);
  const startedAt = value?.startedAt ?? null;
  return {
    work: { kinds: [{ kind: 'approval-continuation', inFlight: running ? 1 : 0,
      completed: value?.completed ?? 0, failed: value?.failed ?? 0,
      oldestPendingAgeMs: running && startedAt ? Math.max(0, nowMs - Date.parse(startedAt)) : 0,
      lastStartedAt: startedAt, lastCompletedAt: value?.completedAt ?? null, lastFailedAt: value?.failedAt ?? null }] },
    ...(value ? { progress: { ...value.progress } } : {}),
  };
}

/** Await from boot/tick. One pass per owner; no detached timers or swallowed shutdown work. */
export async function reconcileApprovalContinuationsFor(deps: ApprovalContinuationDeps, limit = 25): Promise<number> {
  if (deps.isClosing?.() || !supportsApprovalContinuations(deps)) return 0;
  const ledger = deps.configStore!.approvals;
  const active = passes.get(ledger);
  if (active) return await active;
  let metrics = passMetrics.get(ledger);
  if (!metrics) {
    metrics = { completed: 0, failed: 0, startedAt: null, completedAt: null, failedAt: null,
      progress: { scanned: 0, completed: 0, pending: 0, failed: 0 } };
    passMetrics.set(ledger, metrics);
  }
  const owner = metrics;
  owner.startedAt = deps.now();
  owner.progress = { scanned: 0, completed: 0, pending: 0, failed: 0 };
  const work = (async () => {
    const intents = await ledger.pendingContinuations!(limit);
    let completed = 0;
    for (const intent of intents) {
      if (deps.isClosing?.()) break;
      owner.progress.scanned++;
      try {
        const result = await continueApprovalDecisionFor(deps, intent.approval_id);
        if (!result.pending) { completed++; owner.progress.completed++; } else owner.progress.pending++;
      } catch { owner.progress.failed++; /* Durable intent remains pending; later explicit pass retries it. */ }
    }
    return completed;
  })();
  passes.set(ledger, work);
  try {
    const completed = await work;
    owner.completed++; owner.completedAt = deps.now();
    return completed;
  } catch (error) {
    owner.failed++; owner.failedAt = deps.now();
    throw error;
  } finally { if (passes.get(ledger) === work) passes.delete(ledger); }
}
