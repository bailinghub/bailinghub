import type { Job } from './types';
import { truncateUtf8 } from '../platform/http-body';

export type DeliveryKind = 'native_channel' | 'executor_target';
export interface DeliveryDlqRecord {
  id: number;
  parent_job_id?: string;
  channel: string;
  recipient: string;
  content: string;
  resolved: boolean;
  delivery_kind?: DeliveryKind | null;
  notification_job_id?: string | null;
  executor_replay_key?: string | null;
}

export interface DeliveryRequeueInput {
  dlq_id: number;
  replay_key: string;
  job_id: string;
  request_id: string;
  target: string;
  /** Non-SQL adapters recheck the original DLQ under their single-writer lock. */
  isOriginalDelivery?: () => Promise<boolean>;
}
export type DeliveryRequeueOutcome = 'queued' | 'already_queued' | 'in_flight' | 'missing' | 'conflict';

export function deliveryReplayKey(dlqId: number): string {
  if (!Number.isSafeInteger(dlqId) || dlqId <= 0) throw new Error('delivery_dlq_invalid_id');
  return `delivery-dlq:${dlqId}`;
}

/** A DLQ may only replay the original notification child, never its business parent. */
export function isOriginalExecutorDelivery(d: DeliveryDlqRecord, job: Job | null): boolean {
  if (!job || job.source !== 'delivery' || !job.target?.endsWith('-notify') || d.channel !== job.target
    || d.parent_job_id !== job.job_id || (d.notification_job_id && d.notification_job_id !== job.job_id)
    || (d.delivery_kind && d.delivery_kind !== 'executor_target')) return false;
  const recipient = String(job.metadata?.recipient ?? job.metadata?.to ?? '?').slice(0, 512);
  const content = String(job.input ?? '');
  return d.recipient === recipient && (d.content === truncateUtf8(content, 60000) || d.content === content.slice(0, 60000));
}
