import type { Job } from '../core/contracts/types';
import type { ApprovalContinuation } from '../core/contracts/approval-continuation';
import { isAgentToolInvocationJob } from '../app/agent-tool-job';

/** Read-only presentation metadata. Existing mutation routes remain authoritative. */
export function consoleExecution(job: Job) {
  const kind = isAgentToolInvocationJob(job) ? 'agent_tool' : 'hub_task';
  const result = job.result ?? {};
  const uncertain = result['governance_state'] === 'reconciliation_required'
    || result['state'] === 'reconciliation_required'
    || job.error === 'tool_execution_reconciliation_required';
  const reason = uncertain ? 'outcome_unknown' : kind === 'agent_tool' ? 'original_client'
    : ['queued', 'running', 'dispatched'].includes(job.status) ? 'in_flight' : null;
  return { kind, rerun: { available: reason === null, reason } } as const;
}

export function approvalContinuationView(job: Job | null, intent?: ApprovalContinuation | null) {
  // Never infer an automatic continuation from a missing job or failed lookup.
  const mode = job ? (isAgentToolInvocationJob(job) ? 'manual' : 'rerun') : 'unknown';
  return {
    continuation_mode: mode,
    continuation_pending: intent === undefined ? null : Boolean(intent && !intent.completed),
    job_status: job?.status ?? null,
  };
}
