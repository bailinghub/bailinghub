import type { Job } from '../contracts/types';
import { deliveryReplayKey, type DeliveryRequeueInput, type DeliveryRequeueOutcome } from '../contracts/delivery-replay';

export function deliveryRequeuePlan(job: Job | null, input: DeliveryRequeueInput): { outcome: DeliveryRequeueOutcome; patch?: Partial<Job> } {
  if (!job) return { outcome: 'missing' };
  if (!Number.isSafeInteger(input.dlq_id) || input.dlq_id <= 0 || input.replay_key !== deliveryReplayKey(input.dlq_id)
    || job.job_id !== input.job_id || job.request_id !== input.request_id || job.source !== 'delivery'
    || job.target !== input.target || !job.target.endsWith('-notify')) return { outcome: 'conflict' };
  const previous = job.delivery_replay_keys?.[String(input.dlq_id)];
  if (previous !== undefined) return { outcome: previous === input.replay_key ? 'already_queued' : 'conflict' };
  if (['queued', 'running', 'dispatched'].includes(job.status)) return { outcome: 'in_flight' };
  if (job.status !== 'error') return { outcome: 'conflict' };
  return { outcome: 'queued', patch: {
    status: 'queued', attempts: 0, run_after: undefined, error: undefined,
    executor_id: undefined, claimed_at: undefined, lease_until: undefined,
    dispatched_at: undefined, claim_token: undefined,
    delivery_replay_keys: { ...job.delivery_replay_keys, [String(input.dlq_id)]: input.replay_key },
  } };
}
