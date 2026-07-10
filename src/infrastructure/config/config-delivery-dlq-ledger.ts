import { dt } from '../../core/config/config-codec';

export class DeliveryDlqLedger {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async record(d: { parentJobId: string; channel: string; recipient: string; content: string; error: string }): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_delivery_dlq (parent_job_id,channel,recipient,content,error,resolved,created_at) VALUES (?,?,?,?,?,0,?)',
      [d.parentJobId.slice(0, 191), d.channel.slice(0, 191), d.recipient.slice(0, 512), String(d.content ?? '').slice(0, 60000), String(d.error ?? '').slice(0, 2000), dt()],
    );
  }

  async list(includeResolved = false, limit = 100): Promise<Array<{ id: number; parent_job_id: string; channel: string; recipient: string; content_preview: string; error: string; resolved: boolean; created_at: string; resolved_at: string | null }>> {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const [rows] = await this.pool.query(
      `SELECT id,parent_job_id,channel,recipient,LEFT(content,500) AS content_preview,error,resolved,created_at,resolved_at FROM bz_delivery_dlq ${includeResolved ? '' : 'WHERE resolved=0'} ORDER BY id DESC LIMIT ${n}`,
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id), parent_job_id: r.parent_job_id, channel: r.channel, recipient: r.recipient,
      content_preview: r.content_preview ?? '', error: r.error ?? '', resolved: !!r.resolved,
      created_at: new Date(r.created_at).toISOString(), resolved_at: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    }));
  }

  async listByParentJob(parentJobId: string, includeResolved = true, limit = 100): Promise<Array<{ id: number; parent_job_id: string; channel: string; recipient: string; content_preview: string; error: string; resolved: boolean; created_at: string; resolved_at: string | null }>> {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const [rows] = await this.pool.query(
      `SELECT id,parent_job_id,channel,recipient,LEFT(content,500) AS content_preview,error,resolved,created_at,resolved_at FROM bz_delivery_dlq WHERE parent_job_id=? ${includeResolved ? '' : 'AND resolved=0'} ORDER BY id DESC LIMIT ${n}`,
      [parentJobId],
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id), parent_job_id: r.parent_job_id, channel: r.channel, recipient: r.recipient,
      content_preview: r.content_preview ?? '', error: r.error ?? '', resolved: !!r.resolved,
      created_at: new Date(r.created_at).toISOString(), resolved_at: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    }));
  }

  async get(id: number): Promise<{ id: number; channel: string; recipient: string; content: string; resolved: boolean } | null> {
    const [rows] = await this.pool.query('SELECT id,channel,recipient,content,resolved FROM bz_delivery_dlq WHERE id=? LIMIT 1', [id]);
    const r = (rows as any[])[0];
    return r ? { id: Number(r.id), channel: r.channel, recipient: r.recipient, content: r.content ?? '', resolved: !!r.resolved } : null;
  }

  async resolve(id: number): Promise<void> {
    await this.pool.query('UPDATE bz_delivery_dlq SET resolved=1, resolved_at=? WHERE id=?', [dt(), id]);
  }
}
