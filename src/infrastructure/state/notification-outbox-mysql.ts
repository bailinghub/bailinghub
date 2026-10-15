import { randomUUID } from 'node:crypto';
import type { NotificationClaimOptions, NotificationEvent, NotificationListOptions, NotificationOutboxRepository, NotificationSnapshot, NotificationStatus } from '../../core/contracts/notification-outbox';
import { NOTIFICATION_STATUSES } from '../../core/contracts/notification-outbox';
import { notificationKinds, notificationLeaseMs, notificationLimit, notificationOffset, notificationStatuses, safeNotificationError } from '../../core/state/notification-outbox';

const stamp = (iso: string) => new Date(iso).toISOString().replace('T', ' ').replace('Z', '');
const iso = (value: unknown) => value ? new Date(value as string).toISOString() : undefined;
function rowEvent(row: any): NotificationEvent {
  return { event_id: row.event_id, kind: row.kind, job_id: row.job_id, request_id: row.request_id,
    payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json,
    status: row.status, recovery: row.recovery, attempts: Number(row.attempts), cycle_attempts: Number(row.cycle_attempts),
    available_at: iso(row.available_at)!, created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)!,
    lease_token: row.lease_token ?? undefined, lease_owner: row.lease_owner ?? undefined, lease_until: iso(row.lease_until),
    last_error: safeNotificationError(row.last_error ?? undefined), completed_at: iso(row.completed_at) };
}
/** The caller owns the connection transaction; never commits independently. */
export async function insertNotificationEvents(connection: any, events: NotificationEvent[]): Promise<void> {
  for (const event of events) await connection.query(
    'INSERT INTO bz_notification_outbox (event_id,kind,job_id,request_id,payload_json,status,recovery,attempts,cycle_attempts,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [event.event_id, event.kind, event.job_id, event.request_id, JSON.stringify(event.payload), event.status, event.recovery,
      event.attempts, event.cycle_attempts, stamp(event.available_at), stamp(event.created_at), stamp(event.updated_at)]);
}

export class MysqlNotificationOutbox implements NotificationOutboxRepository {
  constructor(private readonly poolOf: () => any) {}
  async claim(options: NotificationClaimOptions): Promise<NotificationEvent[]> {
    const kinds = notificationKinds(options.kinds);
    if (!kinds.length) return [];
    const now = options.now ?? new Date().toISOString(), nowSql = stamp(now);
    const until = new Date(Date.parse(now) + notificationLeaseMs(options.leaseMs)).toISOString();
    const marks = kinds.map(() => '?').join(',');
    const connection = await this.poolOf().getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(`UPDATE bz_notification_outbox SET status='uncertain',last_error='notification_delivery_uncertain',lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE kind IN (${marks}) AND status='processing' AND recovery='uncertain' AND lease_until<=?`, [nowSql, ...kinds, nowSql]);
      const [rows]: any = await connection.query(`SELECT * FROM bz_notification_outbox WHERE kind IN (${marks}) AND ((status='pending' AND available_at<=?) OR (status='processing' AND recovery='retry' AND lease_until<=?)) ORDER BY available_at,event_id LIMIT ${notificationLimit(options.limit)} FOR UPDATE SKIP LOCKED`, [...kinds, nowSql, nowSql]);
      const claimed: NotificationEvent[] = [];
      for (const row of rows) {
        const token = randomUUID();
        await connection.query("UPDATE bz_notification_outbox SET status='processing',attempts=attempts+1,cycle_attempts=cycle_attempts+1,lease_token=?,lease_owner=?,lease_until=?,updated_at=? WHERE event_id=?",
          [token, options.owner.slice(0, 191), stamp(until), nowSql, row.event_id]);
        claimed.push({ ...rowEvent(row), status: 'processing', attempts: Number(row.attempts) + 1, cycle_attempts: Number(row.cycle_attempts) + 1,
          lease_token: token, lease_owner: options.owner.slice(0, 191), lease_until: until, updated_at: now });
      }
      await connection.commit();
      return claimed;
    } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
    finally { connection.release(); }
  }
  async renew(eventId: string, leaseToken: string, leaseMs: number): Promise<boolean> {
    const [result]: any = await this.poolOf().query("UPDATE bz_notification_outbox SET lease_until=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(3)),updated_at=UTC_TIMESTAMP(3) WHERE event_id=? AND status='processing' AND lease_token=? AND lease_until>UTC_TIMESTAMP(3)",
      [notificationLeaseMs(leaseMs) * 1000, eventId, leaseToken]);
    return result.affectedRows === 1;
  }
  async complete(eventId: string, leaseToken: string, outcome: 'completed' | 'skipped' = 'completed', note?: string): Promise<boolean> {
    if (!['completed', 'skipped'].includes(outcome)) return false;
    const [result]: any = await this.poolOf().query("UPDATE bz_notification_outbox SET status=?,last_error=?,completed_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3),lease_token=NULL,lease_until=NULL,lease_owner=NULL WHERE event_id=? AND status='processing' AND lease_token=? AND lease_until>UTC_TIMESTAMP(3)",
      [outcome, safeNotificationError(note) ?? null, eventId, leaseToken]);
    return result.affectedRows === 1;
  }
  async fail(eventId: string, leaseToken: string, options: Parameters<NotificationOutboxRepository['fail']>[2]): Promise<boolean> {
    if (!['pending', 'failed', 'uncertain'].includes(options.status)) return false;
    const now = new Date().toISOString();
    const [result]: any = await this.poolOf().query("UPDATE bz_notification_outbox SET status=?,last_error=?,available_at=?,updated_at=UTC_TIMESTAMP(3),lease_token=NULL,lease_until=NULL,lease_owner=NULL WHERE event_id=? AND status='processing' AND lease_token=? AND lease_until>UTC_TIMESTAMP(3)",
      [options.status, safeNotificationError(options.error), stamp(options.availableAt ?? now), eventId, leaseToken]);
    return result.affectedRows === 1;
  }
  async retry(eventId: string, options: Parameters<NotificationOutboxRepository['retry']>[1] = {}): Promise<boolean> {
    if (options.expectedStatus && !['failed', 'uncertain'].includes(options.expectedStatus)) return false;
    const now = stamp(options.now ?? new Date().toISOString());
    const statuses = options.allowUncertain ? ['failed', 'uncertain'] : ['failed'];
    const expected = options.expectedStatus ? ' AND status=?' : '';
    const [result]: any = await this.poolOf().query(`UPDATE bz_notification_outbox SET status='pending',cycle_attempts=0,available_at=?,updated_at=?,lease_token=NULL,lease_until=NULL,lease_owner=NULL,completed_at=NULL WHERE event_id=? AND status IN (${statuses.map(() => '?').join(',')})${expected}`,
      [now, now, eventId, ...statuses, ...(options.expectedStatus ? [options.expectedStatus] : [])]);
    return result.affectedRows === 1;
  }
  async get(eventId: string): Promise<NotificationEvent | null> {
    const [rows]: any = await this.poolOf().query('SELECT * FROM bz_notification_outbox WHERE event_id=?', [eventId]);
    return rows[0] ? rowEvent(rows[0]) : null;
  }
  async list(options: NotificationListOptions = {}): Promise<NotificationEvent[]> {
    const kinds = notificationKinds(options.kinds), statuses = notificationStatuses(options.statuses);
    if (!kinds.length || !statuses.length) return [];
    const [rows]: any = await this.poolOf().query(`SELECT * FROM bz_notification_outbox WHERE kind IN (${kinds.map(() => '?').join(',')}) AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at DESC,event_id DESC LIMIT ${notificationLimit(options.limit)} OFFSET ${notificationOffset(options.offset)}`, [...kinds, ...statuses]);
    return rows.map(rowEvent);
  }
  async snapshot(options: Parameters<NotificationOutboxRepository['snapshot']>[0] = {}): Promise<NotificationSnapshot> {
    const kinds = notificationKinds(options.kinds), now = options.now ?? new Date().toISOString();
    const counts = Object.fromEntries(NOTIFICATION_STATUSES.map(status => [status, 0])) as NotificationSnapshot['counts'];
    if (!kinds.length) return { counts, oldestPendingAgeSeconds: 0, expiredLeases: 0 };
    const [rows]: any = await this.poolOf().query(`SELECT status,COUNT(*) AS n,MIN(CASE WHEN status='pending' THEN created_at END) AS oldest,SUM(CASE WHEN status='processing' AND lease_until<=? THEN 1 ELSE 0 END) AS expired FROM bz_notification_outbox WHERE kind IN (${kinds.map(() => '?').join(',')}) GROUP BY status`, [stamp(now), ...kinds]);
    let oldest = Infinity, expiredLeases = 0;
    for (const row of rows) {
      if (NOTIFICATION_STATUSES.includes(row.status)) counts[row.status as NotificationStatus] = Number(row.n);
      if (row.oldest) oldest = Math.min(oldest, Date.parse(iso(row.oldest)!));
      expiredLeases += Number(row.expired ?? 0);
    }
    return { counts, oldestPendingAgeSeconds: Number.isFinite(oldest) ? Math.max(0, (Date.parse(now) - oldest) / 1000) : 0, expiredLeases };
  }
}
