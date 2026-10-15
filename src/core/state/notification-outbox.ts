import { randomUUID } from 'node:crypto';
import type { Job } from '../contracts/types';
import { NOTIFICATION_KINDS, NOTIFICATION_STATUSES, type NotificationEvent, type NotificationKind, type NotificationSnapshot, type NotificationStatus } from '../contracts/notification-outbox';

export function copyNotification<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function terminalJob(job: Job): boolean { return ['done', 'error', 'rejected'].includes(job.status); }
export function completionMatches(current: Job | null, original: Job): boolean {
  return !!current && !terminalJob(current) && current.job_id === original.job_id && current.request_id === original.request_id
    && current.status === original.status && (current.claim_token ?? null) === (original.claim_token ?? null)
    && (current.executor_id ?? null) === (original.executor_id ?? null)
    && (current.claimed_at ?? null) === (original.claimed_at ?? null);
}
export function newNotification(eventId: string, kind: NotificationKind, payload: NotificationEvent['payload'], now: string,
  recovery: NotificationEvent['recovery'] = 'retry'): NotificationEvent {
  return { event_id: eventId, kind, job_id: payload.job.job_id, request_id: payload.job.request_id,
    payload: copyNotification(payload), status: 'pending', attempts: 0, cycle_attempts: 0, recovery,
    available_at: now, created_at: now, updated_at: now };
}
/** Called only in the store's atomic nonterminal -> terminal write, never during recovery scans. */
export function terminalNotifications(previous: Job, next: Job, context?: { brandName?: string }): NotificationEvent[] {
  if (terminalJob(previous) || !terminalJob(next)) return [];
  const prefix = `job:${randomUUID()}`;
  const events: NotificationEvent[] = [];
  const add = (kind: NotificationKind, recovery: NotificationEvent['recovery'] = 'retry') =>
    events.push(newNotification(`${prefix}:${kind}`, kind, { job: next, brand_name: context?.brandName ?? 'BailingHub' }, next.updated_at, recovery));
  if (next.callback_url) add('callback');
  const deliveryType = String(next.dispatch?.delivery?.['type'] ?? '');
  const native = next.source.startsWith('wecom:') || deliveryType === 'channel';
  if ((next.status === 'done' || next.status === 'error') && next.source !== 'delivery' && !next.metadata?.['no_delivery']
    && (deliveryType || next.source.startsWith('wecom:'))) add('delivery', native ? 'uncertain' : 'retry');
  if (next.status === 'error' && (next.source === 'delivery' || next.target?.endsWith('-notify'))) add('delivery-dlq');
  return events;
}
// Only codes produced by Core itself may cross the persisted status/UI boundary.
// Sources: the outbox worker and lease recovery, delivery/approval binding checks,
// and postSignedNotificationWithDeps. Provider error text is never an error code.
const SAFE_NOTIFICATION_ERROR_CODES = new Set([
  'notification_delivery_failed',
  'notification_delivery_uncertain',
  'notification_attempt_limit',
  'notification_child_binding_conflict',
  'approval_notification_binding_conflict',
  'webhook_acknowledgement_unavailable',
]);

export function safeNotificationError(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return SAFE_NOTIFICATION_ERROR_CODES.has(value) || (value.length === 16 && /^webhook_http_[1-5][0-9]{2}$/.test(value))
    ? value : 'notification_delivery_failed';
}
export function notificationLimit(value: number | undefined): number { return Math.min(100, Math.max(1, Math.trunc(value ?? 25) || 25)); }
export function notificationOffset(value: number | undefined): number { return Number.isSafeInteger(value) && value! >= 0 ? Math.min(value!, 1_000_000) : 0; }
export function notificationKinds(kinds?: NotificationKind[]): NotificationKind[] { return kinds === undefined ? [...NOTIFICATION_KINDS] : [...new Set(kinds.filter(kind => NOTIFICATION_KINDS.includes(kind)))]; }
export function notificationStatuses(statuses?: NotificationStatus[]): NotificationStatus[] { return statuses === undefined ? [...NOTIFICATION_STATUSES] : [...new Set(statuses.filter(status => NOTIFICATION_STATUSES.includes(status)))]; }
export function notificationLeaseMs(ms?: number): number { return Math.min(600_000, Math.max(100, Math.trunc(ms ?? 60_000) || 60_000)); }
export function notificationSnapshot(events: NotificationEvent[], now: string): NotificationSnapshot {
  const counts = Object.fromEntries(NOTIFICATION_STATUSES.map(status => [status, 0])) as NotificationSnapshot['counts'];
  let oldest = Infinity, expiredLeases = 0;
  const stamp = Date.parse(now);
  for (const event of events) {
    counts[event.status]++;
    if (event.status === 'pending') oldest = Math.min(oldest, Date.parse(event.created_at));
    if (event.status === 'processing' && Date.parse(event.lease_until ?? '') <= stamp) expiredLeases++;
  }
  return { counts, oldestPendingAgeSeconds: Number.isFinite(oldest) ? Math.max(0, (stamp - oldest) / 1000) : 0, expiredLeases };
}
