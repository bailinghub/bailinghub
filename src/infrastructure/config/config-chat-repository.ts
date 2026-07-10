import { dt, rowChatEntry, rowPageContext } from '../../core/config/config-codec';
import type { PageRule } from '../../core/platform/pagecontext';
import type { ChatEntry, JobRating } from '../../core/contracts/types';

export class ChatConfigRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async list(): Promise<ChatEntry[]> {
    const [rows] = await this.pool.query('SELECT * FROM bz_chat_entries ORDER BY name');
    return (rows as any[]).map(rowChatEntry);
  }

  async get(entryKey: string): Promise<ChatEntry | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_chat_entries WHERE entry_key=? LIMIT 1', [entryKey]);
    return rows[0] ? rowChatEntry(rows[0]) : null;
  }

  async upsert(e: ChatEntry): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_chat_entries (entry_key,name,route_key,enabled,allowed_origins,rate_limit_per_min,ticket_client,bucket,title,greeting,color,appearance,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE name=VALUES(name),route_key=VALUES(route_key),enabled=VALUES(enabled),allowed_origins=VALUES(allowed_origins),rate_limit_per_min=VALUES(rate_limit_per_min),ticket_client=VALUES(ticket_client),bucket=VALUES(bucket),title=VALUES(title),greeting=VALUES(greeting),color=VALUES(color),appearance=VALUES(appearance),description=VALUES(description),updated_at=VALUES(updated_at)',
      [e.entry_key, e.name, e.route_key, e.enabled ? 1 : 0, JSON.stringify(e.allowed_origins ?? []),
       e.rate_limit_per_min, e.ticket_client ?? null, e.bucket ?? null, e.title ?? null, e.greeting ?? null, e.color ?? null,
       e.appearance && Object.keys(e.appearance).length ? JSON.stringify(e.appearance) : null, e.description ?? null, dt(), dt()],
    );
  }

  async delete(entryKey: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_chat_entries WHERE entry_key=?', [entryKey]);
  }

  async listPageContexts(entryKey: string): Promise<PageRule[]> {
    const [rows] = await this.pool.query(
      'SELECT * FROM bz_page_contexts WHERE entry_key=? ORDER BY priority DESC, id ASC', [entryKey],
    );
    return (rows as any[]).map(rowPageContext);
  }

  async upsertPageContext(r: PageRule): Promise<number> {
    if (r.id) {
      await this.pool.query(
        'UPDATE bz_page_contexts SET url_pattern=?,page_key=?,page_name=?,description=?,kb_tag=?,priority=?,enabled=?,updated_at=? WHERE id=? AND entry_key=?',
        [r.url_pattern, r.page_key ?? null, r.page_name ?? null, r.description ?? null, r.kb_tag ?? null, Number(r.priority) || 0, r.enabled === false ? 0 : 1, dt(), r.id, r.entry_key],
      );
      return r.id;
    }
    const [res]: any = await this.pool.query(
      'INSERT INTO bz_page_contexts (entry_key,url_pattern,page_key,page_name,description,kb_tag,priority,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [r.entry_key, r.url_pattern, r.page_key ?? null, r.page_name ?? null, r.description ?? null, r.kb_tag ?? null, Number(r.priority) || 0, r.enabled === false ? 0 : 1, dt(), dt()],
    );
    return Number(res?.insertId ?? 0);
  }

  async deletePageContext(id: number, entryKey: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_page_contexts WHERE id=? AND entry_key=?', [id, entryKey]);
  }

  async upsertJobRating(r: Omit<JobRating, 'created_at' | 'updated_at'>): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_job_ratings (job_id,entry_key,visitor_id,rating,comment,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE rating=VALUES(rating),comment=VALUES(comment),updated_at=VALUES(updated_at)',
      [r.job_id, r.entry_key, r.visitor_id, r.rating, r.comment ?? null, dt(), dt()],
    );
  }

  /** 评价列表（带问题/回答摘要，控制台运营用）。entryKey 可选过滤。 */
  async listJobRatings(entryKey?: string, limit = 50): Promise<Array<JobRating & { question?: string; reply?: string }>> {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const where = entryKey ? 'WHERE r.entry_key=?' : '';
    const [rows] = await this.pool.query(
      `SELECT r.*, j.input_preview AS question, LEFT(JSON_UNQUOTE(JSON_EXTRACT(j.result,'$.text')),300) AS reply ` +
        `FROM bz_job_ratings r LEFT JOIN bz_jobs j ON j.job_id=r.job_id ${where} ORDER BY r.updated_at DESC LIMIT ${n}`,
      entryKey ? [entryKey] : [],
    );
    return (rows as any[]).map((x) => ({
      job_id: x.job_id, entry_key: x.entry_key, visitor_id: x.visitor_id, rating: x.rating,
      comment: x.comment ?? undefined, question: x.question ?? undefined, reply: x.reply ?? undefined,
      created_at: new Date(x.created_at).toISOString(), updated_at: new Date(x.updated_at).toISOString(),
    }));
  }
}
