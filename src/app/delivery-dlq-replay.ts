import { isOriginalExecutorDelivery, type DeliveryDlqRecord } from '../core/contracts/delivery-replay';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { DeliveryDlqLedgerContract } from '../infrastructure/config/configstore';

export class DeliveryReplayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export async function classifyDeliveryDlq(d: DeliveryDlqRecord, state: RuntimeStateStore): Promise<'native_channel' | 'executor_target'> {
  if (d.delivery_kind === 'native_channel') return 'native_channel';
  if (d.delivery_kind && d.delivery_kind !== 'executor_target') throw new DeliveryReplayError(409, 'delivery_dlq_binding_conflict');
  const job = d.parent_job_id ? await state.getJob(d.notification_job_id || d.parent_job_id) : null;
  if (isOriginalExecutorDelivery(d, job)) return 'executor_target';
  // Legacy native records point to the business parent. Only an executor-shaped
  // record is ambiguous; never redirect it to a native channel of the same name.
  if (d.delivery_kind === 'executor_target' || d.notification_job_id || job?.source === 'delivery') throw new DeliveryReplayError(409, 'delivery_dlq_binding_conflict');
  if (job && job.target !== d.channel) return 'native_channel';
  if (d.channel.endsWith('-notify')) throw new DeliveryReplayError(409, 'delivery_dlq_binding_conflict');
  return 'native_channel';
}

export async function replayExecutorDeliveryDlq(d: DeliveryDlqRecord, ledger: DeliveryDlqLedgerContract, state: RuntimeStateStore): Promise<{ queued: boolean; duplicate: boolean }> {
  if (!ledger.ensureExecutorReplay || !state.requeueDeliveryJobOnce) throw new DeliveryReplayError(503, 'delivery_dlq_replay_unavailable');
  const jobId = d.notification_job_id || d.parent_job_id;
  const job = jobId ? await state.getJob(jobId) : null;
  if (!job || !isOriginalExecutorDelivery(d, job)) throw new DeliveryReplayError(409, 'delivery_dlq_binding_conflict');
  const replay = await ledger.ensureExecutorReplay(d.id, job.job_id);
  if (!replay) return { queued: false, duplicate: true };
  const outcome = await state.requeueDeliveryJobOnce({ dlq_id: d.id, replay_key: replay.key,
    job_id: job.job_id, request_id: job.request_id, target: job.target!,
    isOriginalDelivery: async () => {
      const current = await ledger.get(d.id);
      return Boolean(current && !current.resolved && current.executor_replay_key === replay.key && isOriginalExecutorDelivery(current, job));
    } });
  if (outcome === 'in_flight') throw new DeliveryReplayError(409, 'delivery_notification_in_flight');
  if (outcome === 'missing' || outcome === 'conflict') throw new DeliveryReplayError(409, 'delivery_dlq_binding_conflict');
  // A lost resolve acknowledgement is safe: the permanent state marker is
  // checked before any later admission, including after the child has completed.
  await ledger.resolve(d.id);
  return { queued: outcome === 'queued', duplicate: outcome === 'already_queued' };
}
