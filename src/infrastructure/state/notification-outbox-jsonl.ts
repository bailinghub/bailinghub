import { randomUUID } from 'node:crypto';
import type { NotificationClaimOptions, NotificationEvent, NotificationListOptions, NotificationOutboxRepository, NotificationSnapshot } from '../../core/contracts/notification-outbox';
import { copyNotification, notificationKinds, notificationLeaseMs, notificationLimit, notificationOffset, notificationSnapshot, notificationStatuses, safeNotificationError } from '../../core/state/notification-outbox';

/** Shares the owning JsonlStore's single writer and journal. */
export class JsonlNotificationOutbox implements NotificationOutboxRepository {
  private readonly events = new Map<string, NotificationEvent>();
  constructor(private readonly serial: <T>(work: () => Promise<T>) => Promise<T>, private readonly persist: (events: NotificationEvent[]) => Promise<void>) {}
  publish(events: NotificationEvent[]): void { for (const event of events) this.events.set(event.event_id, copyNotification(event)); }
  private async save(events: NotificationEvent[]): Promise<void> { if (!events.length) return; await this.persist(events); this.publish(events); }
  async claim(options: NotificationClaimOptions): Promise<NotificationEvent[]> {
    return this.serial(async () => {
      const now = options.now ?? new Date().toISOString(), nowMs = Date.parse(now), kinds = notificationKinds(options.kinds);
      const expired = [...this.events.values()].filter(event => kinds.includes(event.kind) && event.status === 'processing'
        && event.recovery === 'uncertain' && Date.parse(event.lease_until ?? '') <= nowMs);
      await this.save(expired.map(event => ({ ...event, status: 'uncertain', last_error: 'notification_delivery_uncertain', updated_at: now,
        lease_token: undefined, lease_owner: undefined, lease_until: undefined })));
      const candidates = [...this.events.values()].filter(event => kinds.includes(event.kind)
        && ((event.status === 'pending' && Date.parse(event.available_at) <= nowMs)
          || (event.status === 'processing' && event.recovery === 'retry' && Date.parse(event.lease_until ?? '') <= nowMs)))
        .sort((a, b) => a.available_at.localeCompare(b.available_at) || a.event_id.localeCompare(b.event_id))
        .slice(0, notificationLimit(options.limit));
      const claimed = candidates.map(event => ({ ...event, status: 'processing' as const, attempts: event.attempts + 1,
        cycle_attempts: event.cycle_attempts + 1, lease_token: randomUUID(), lease_owner: options.owner.slice(0, 191),
        lease_until: new Date(nowMs + notificationLeaseMs(options.leaseMs)).toISOString(), updated_at: now }));
      await this.save(claimed);
      return copyNotification(claimed);
    });
  }
  private leased(eventId: string, token: string, now: string): NotificationEvent | null {
    const event = this.events.get(eventId);
    return event?.status === 'processing' && event.lease_token === token && Date.parse(event.lease_until ?? '') > Date.parse(now) ? event : null;
  }
  async renew(eventId: string, token: string, leaseMs: number): Promise<boolean> {
    return this.serial(async () => {
      const now = new Date().toISOString(), event = this.leased(eventId, token, now);
      if (!event) return false;
      await this.save([{ ...event, updated_at: now, lease_until: new Date(Date.parse(now) + notificationLeaseMs(leaseMs)).toISOString() }]);
      return true;
    });
  }
  async complete(eventId: string, token: string, outcome: 'completed' | 'skipped' = 'completed', note?: string): Promise<boolean> {
    return this.serial(async () => {
      const now = new Date().toISOString(), event = this.leased(eventId, token, now);
      if (!event || !['completed', 'skipped'].includes(outcome)) return false;
      await this.save([{ ...event, status: outcome, updated_at: now, completed_at: now, last_error: safeNotificationError(note),
        lease_token: undefined, lease_until: undefined, lease_owner: undefined }]);
      return true;
    });
  }
  async fail(eventId: string, token: string, options: Parameters<NotificationOutboxRepository['fail']>[2]): Promise<boolean> {
    return this.serial(async () => {
      const now = new Date().toISOString(), event = this.leased(eventId, token, now);
      if (!event || !['pending', 'failed', 'uncertain'].includes(options.status)) return false;
      await this.save([{ ...event, status: options.status, available_at: options.availableAt ?? now, updated_at: now,
        last_error: safeNotificationError(options.error), lease_token: undefined, lease_until: undefined, lease_owner: undefined }]);
      return true;
    });
  }
  async retry(eventId: string, options: Parameters<NotificationOutboxRepository['retry']>[1] = {}): Promise<boolean> {
    return this.serial(async () => {
      const event = this.events.get(eventId), now = options.now ?? new Date().toISOString();
      if (!event || (options.expectedStatus && event.status !== options.expectedStatus)
        || (event.status !== 'failed' && !(event.status === 'uncertain' && options.allowUncertain))) return false;
      await this.save([{ ...event, status: 'pending', cycle_attempts: 0, available_at: now, updated_at: now,
        lease_token: undefined, lease_until: undefined, lease_owner: undefined, completed_at: undefined }]);
      return true;
    });
  }
  async get(eventId: string): Promise<NotificationEvent | null> { return copyNotification(this.events.get(eventId) ?? null); }
  async list(options: NotificationListOptions = {}): Promise<NotificationEvent[]> {
    const kinds = notificationKinds(options.kinds), statuses = notificationStatuses(options.statuses), offset = notificationOffset(options.offset);
    return copyNotification([...this.events.values()].filter(event => kinds.includes(event.kind) && statuses.includes(event.status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.event_id.localeCompare(a.event_id)).slice(offset, offset + notificationLimit(options.limit)));
  }
  async snapshot(options: Parameters<NotificationOutboxRepository['snapshot']>[0] = {}): Promise<NotificationSnapshot> {
    const kinds = notificationKinds(options.kinds);
    return notificationSnapshot([...this.events.values()].filter(event => kinds.includes(event.kind)), options.now ?? new Date().toISOString());
  }
}
