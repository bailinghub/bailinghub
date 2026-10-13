import type { ApprovalRequeueInput, ApprovalRequeueOutcome } from '../contracts/approval-continuation';
import type { Job } from '../contracts/types';

/** Only the state adapter may commit this patch, atomically with its queue transition. */
export function approvalRequeuePlan(job: Job | null, input: ApprovalRequeueInput): { outcome: ApprovalRequeueOutcome; patch?: Partial<Job> } {
  if (!job) return { outcome: 'missing' };
  if (!Number.isSafeInteger(input.approval_id) || input.approval_id <= 0 || !input.decision_key
    || input.decision_key.length > 160 || job.job_id !== input.job_id || job.request_id !== input.request_id
    || job.target === 'agent-tool-v1') return { outcome: 'conflict' };
  const key = String(input.approval_id);
  const previous = job.approval_continuation_keys?.[key];
  if (previous !== undefined) return { outcome: previous === input.decision_key ? 'already_queued' : 'conflict' };
  if (!['done', 'error', 'rejected'].includes(job.status)) return { outcome: 'in_flight' };
  const metadata = { ...job.metadata };
  delete metadata.no_delivery;
  return { outcome: 'queued', patch: {
    status: 'queued', attempts: 0, run_after: undefined, error: undefined,
    executor_id: undefined, claimed_at: undefined, lease_until: undefined,
    dispatched_at: undefined, claim_token: undefined, metadata,
    approval_continuation_keys: { ...job.approval_continuation_keys, [key]: input.decision_key },
  } };
}
