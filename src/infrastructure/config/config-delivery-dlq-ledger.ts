import { dt } from '../../core/config/config-codec';
import { deliveryReplayKey, type DeliveryKind, type DeliveryDlqRecord } from '../../core/contracts/delivery-replay';
import { truncateUtf8 } from '../../core/platform/http-body';

export class DeliveryDlqLedger {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async record(d: { parentJobId: string; channel: string; recipient: string; content: string; error: string; deliveryKind?: DeliveryKind; notificationJobId?: string; eventId?: string }): Promise<void> {
    if (d.eventId !== undefined && (!d.eventId || d.eventId.length > 191)) throw new Error('notification_dlq_event_invalid');
    const binding = [d.parentJobId.slice(0, 191), d.channel.slice(0, 191), d.recipient.slice(0, 512), truncateUtf8(String(d.content ?? ''), 60000)];
    try {
      await this.pool.query(
        `INSERT INTO bz_delivery_dlq (parent_job_id,channel,recipient,content,error,delivery_kind,notification_job_id,resolved,created_at${d.eventId ? ',event_id' : ''}) VALUES (?,?,?,?,?,?,?,0,?${d.eventId ? ',?' : ''})`,
        [...binding, String(d.error ?? '').slice(0, 2000), d.deliveryKind ?? null, d.notificationJobId?.slice(0, 191) ?? null, dt(), ...(d.eventId ? [d.eventId] : [])]);
    } catch (error) {
      if (!d.eventId || (error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error;
      const [rows]: any = await this.pool.query('SELECT parent_job_id,channel,recipient,content,delivery_kind,notification_job_id FROM bz_delivery_dlq WHERE event_id=?', [d.eventId]);
      const row = rows[0];
      if (!row || JSON.stringify([row.parent_job_id, row.channel, row.recipient, row.content]) !== JSON.stringify(binding)
        || (row.delivery_kind ?? null) !== (d.deliveryKind ?? null) || (row.notification_job_id ?? null) !== (d.notificationJobId?.slice(0, 191) ?? null)) throw new Error('notification_dlq_identity_conflict');
    }
  }

  async list(includeResolved = false, limit = 100): Promise<Array<{ id: number; parent_job_id: string; channel: string; recipient: string; content_preview: string; error: string; resolved: boolean; created_at: string; resolved_at: string | null; delivery_kind?: DeliveryKind | null; notification_job_id?: string | null; executor_replay_key?: string | null; event_id?: string | null }>> {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const [rows] = await this.pool.query(
      `SELECT id,parent_job_id,channel,recipient,LEFT(content,500) AS content_preview,error,resolved,created_at,resolved_at,delivery_kind,notification_job_id,executor_replay_key,event_id FROM bz_delivery_dlq ${includeResolved ? '' : 'WHERE resolved=0'} ORDER BY id DESC LIMIT ${n}`,
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id), parent_job_id: r.parent_job_id, channel: r.channel, recipient: r.recipient,
      content_preview: r.content_preview ?? '', error: r.error ?? '', resolved: !!r.resolved,
      delivery_kind: r.delivery_kind, notification_job_id: r.notification_job_id, executor_replay_key: r.executor_replay_key, event_id: r.event_id,
      created_at: new Date(r.created_at).toISOString(), resolved_at: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    }));
  }

  async listByParentJob(parentJobId: string, includeResolved = true, limit = 100): Promise<Array<{ id: number; parent_job_id: string; channel: string; recipient: string; content_preview: string; error: string; resolved: boolean; created_at: string; resolved_at: string | null; delivery_kind?: DeliveryKind | null; notification_job_id?: string | null; executor_replay_key?: string | null; event_id?: string | null }>> {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const [rows] = await this.pool.query(
      `SELECT id,parent_job_id,channel,recipient,LEFT(content,500) AS content_preview,error,resolved,created_at,resolved_at,delivery_kind,notification_job_id,executor_replay_key,event_id FROM bz_delivery_dlq WHERE parent_job_id=? ${includeResolved ? '' : 'AND resolved=0'} ORDER BY id DESC LIMIT ${n}`,
      [parentJobId],
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id), parent_job_id: r.parent_job_id, channel: r.channel, recipient: r.recipient,
      content_preview: r.content_preview ?? '', error: r.error ?? '', resolved: !!r.resolved,
      delivery_kind: r.delivery_kind, notification_job_id: r.notification_job_id, executor_replay_key: r.executor_replay_key, event_id: r.event_id,
      created_at: new Date(r.created_at).toISOString(), resolved_at: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    }));
  }

  async get(id: number): Promise<DeliveryDlqRecord | null> {
    const [rows] = await this.pool.query('SELECT id,parent_job_id,channel,recipient,content,resolved,delivery_kind,notification_job_id,executor_replay_key,event_id FROM bz_delivery_dlq WHERE id=? LIMIT 1', [id]);
    const r = (rows as any[])[0];
    return r ? { id: Number(r.id), parent_job_id: r.parent_job_id, channel: r.channel, recipient: r.recipient,
      content: r.content ?? '', resolved: !!r.resolved, delivery_kind: r.delivery_kind,
      notification_job_id: r.notification_job_id, executor_replay_key: r.executor_replay_key, event_id: r.event_id } : null;
  }

  /** Stable replay identity is initialized once; it never acts as an expiring owner lease. */
  async ensureExecutorReplay(id: number, notificationJobId: string): Promise<{ key: string; created: boolean } | null> {
    const key = deliveryReplayKey(id);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM bz_delivery_dlq WHERE id=? FOR UPDATE', [id]);
      const row = (rows as any[])[0];
      if (!row || row.resolved) { await conn.commit(); return null; }
      if (row.parent_job_id !== notificationJobId || (row.notification_job_id && row.notification_job_id !== notificationJobId)
        || (row.delivery_kind && row.delivery_kind !== 'executor_target') || (row.executor_replay_key && row.executor_replay_key !== key)) throw new Error('delivery_dlq_replay_conflict');
      const created = !row.executor_replay_key;
      if (created) await conn.query("UPDATE bz_delivery_dlq SET delivery_kind='executor_target',notification_job_id=?,executor_replay_key=? WHERE id=?", [notificationJobId, key, id]);
      await conn.commit();
      return { key, created };
    } catch (error) {
      await conn.rollback().catch(() => undefined); throw error;
    } finally { conn.release(); }
  }

  async resolveByEventId(eventId: string): Promise<void> {
    await this.pool.query('UPDATE bz_delivery_dlq SET resolved=1, resolved_at=COALESCE(resolved_at,?) WHERE event_id=?', [dt(), eventId]);
  }

  async resolve(id: number): Promise<void> {
    await this.pool.query('UPDATE bz_delivery_dlq SET resolved=1, resolved_at=? WHERE id=?', [dt(), id]);
  }
}
