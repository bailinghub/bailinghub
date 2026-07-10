import { randomUUID } from 'node:crypto';
import { dt, rowThreadHead } from '../../core/config/config-codec';
import type { Route } from '../../core/contracts/types';

export interface SessionResolution {
  sessionId: string;
  isContinue: boolean;
  scopeKey: string;
}

export class ConversationLedger {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async rawInputForJob(jobId: string): Promise<string | null> {
    const [rows] = await this.pool.query("SELECT content FROM bz_messages WHERE job_id=? AND direction='in' ORDER BY id LIMIT 1", [jobId]);
    return rows[0] ? String((rows[0] as any).content) : null;
  }

  async sessionForScope(routeKey: string, scopeKey: string): Promise<SessionResolution> {
    return this.findOrCreateSession(routeKey, scopeKey);
  }

  async resolveSession(route: Route, metadata: Record<string, unknown>): Promise<SessionResolution> {
    if (route.session_policy === 'new') {
      return { sessionId: randomUUID(), isContinue: false, scopeKey: '' };
    }
    if (route.session_policy === 'fixed' && route.session_fixed_id) {
      return { sessionId: route.session_fixed_id, isContinue: true, scopeKey: '__fixed__' };
    }
    if (route.session_policy === 'passthrough') {
      const field = route.session_key_field || 'session_id';
      const v = String(metadata[field] ?? '').trim();
      if (v) return { sessionId: v.slice(0, 191), isContinue: true, scopeKey: '' };
      return { sessionId: randomUUID(), isContinue: false, scopeKey: '' };
    }
    let scopeKey = '__singleton__';
    if (route.session_policy === 'per_key') {
      const field = route.session_key_field ?? '';
      const v = field ? metadata[field] : undefined;
      if (v === undefined || v === null || String(v) === '') {
        return { sessionId: randomUUID(), isContinue: false, scopeKey: '' };
      }
      scopeKey = String(v).slice(0, 191);
    }
    return this.findOrCreateSession(route.route_key, scopeKey);
  }

  private async findOrCreateSession(routeKey: string, scopeKey: string): Promise<SessionResolution> {
    const [rows] = await this.pool.query(
      'SELECT session_id FROM bz_sessions WHERE route_key=? AND scope_key=? LIMIT 1',
      [routeKey, scopeKey],
    );
    if (rows[0]) {
      await this.pool.query('UPDATE bz_sessions SET last_used_at=? WHERE route_key=? AND scope_key=?', [dt(), routeKey, scopeKey]);
      return { sessionId: rows[0].session_id, isContinue: true, scopeKey };
    }
    const sid = randomUUID();
    try {
      await this.pool.query(
        'INSERT INTO bz_sessions (route_key,scope_key,session_id,created_at,last_used_at) VALUES (?,?,?,?,?)',
        [routeKey, scopeKey, sid, dt(), dt()],
      );
      return { sessionId: sid, isContinue: false, scopeKey };
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY') {
        const [r2] = await this.pool.query(
          'SELECT session_id FROM bz_sessions WHERE route_key=? AND scope_key=? LIMIT 1',
          [routeKey, scopeKey],
        );
        if (r2[0]) return { sessionId: r2[0].session_id, isContinue: true, scopeKey };
      }
      throw e;
    }
  }

  async resolveThread(routeKey: string, scopeKey: string, principalId?: string | null): Promise<number> {
    const [rows] = await this.pool.query(
      'SELECT thread_id FROM bz_threads WHERE route_key=? AND scope_key=? LIMIT 1',
      [routeKey, scopeKey],
    );
    if (rows[0]) return Number(rows[0].thread_id);
    try {
      const [r]: any = await this.pool.query(
        'INSERT INTO bz_threads (route_key,scope_key,principal_id,message_count,created_at,last_active_at) VALUES (?,?,?,0,?,?)',
        [routeKey, scopeKey, principalId ?? null, dt(), dt()],
      );
      return Number(r.insertId);
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY') {
        const [r2] = await this.pool.query(
          'SELECT thread_id FROM bz_threads WHERE route_key=? AND scope_key=? LIMIT 1',
          [routeKey, scopeKey],
        );
        if (r2[0]) return Number(r2[0].thread_id);
      }
      throw e;
    }
  }

  async appendMessage(m: { thread_id: number; direction: 'in' | 'out'; channel: string; principal_id?: string | null; job_id?: string | null; content: string }): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_messages (thread_id,direction,channel,principal_id,job_id,content,created_at) VALUES (?,?,?,?,?,?,?)',
      [m.thread_id, m.direction, m.channel, m.principal_id ?? null, m.job_id ?? null, m.content, dt()],
    );
    await this.pool.query(
      'UPDATE bz_threads SET message_count=message_count+1, last_active_at=? WHERE thread_id=?',
      [dt(), m.thread_id],
    );
  }

  async recentMessages(threadId: number, n = 12): Promise<Array<{ direction: string; channel: string; content: string; created_at: string }>> {
    const [rows] = await this.pool.query(
      `SELECT direction,channel,content,created_at FROM bz_messages WHERE thread_id=? ORDER BY id DESC LIMIT ${Math.min(Math.max(n, 1), 50)}`,
      [threadId],
    );
    return (rows as any[]).reverse().map((r) => ({
      direction: r.direction, channel: r.channel, content: r.content,
      created_at: new Date(r.created_at).toISOString(),
    }));
  }

  async getThreadMemory(threadId: number): Promise<{ summary: string | null; summary_upto_id: number }> {
    const [rows] = await this.pool.query('SELECT summary, summary_upto_id FROM bz_threads WHERE thread_id=? LIMIT 1', [threadId]);
    const r = (rows as any[])[0];
    return { summary: r?.summary ?? null, summary_upto_id: Number(r?.summary_upto_id ?? 0) };
  }

  async recentMessagesAfter(threadId: number, afterId: number, n = 12): Promise<Array<{ direction: string; channel: string; content: string; created_at: string }>> {
    const lim = Math.min(Math.max(n, 1), 50);
    const [rows] = await this.pool.query(
      `SELECT direction,channel,content,created_at FROM bz_messages WHERE thread_id=? AND id>? ORDER BY id DESC LIMIT ${lim}`,
      [threadId, afterId],
    );
    return (rows as any[]).reverse().map((r) => ({ direction: r.direction, channel: r.channel, content: r.content, created_at: new Date(r.created_at).toISOString() }));
  }

  async unsummarizedMessages(threadId: number, afterId: number, limit = 500): Promise<Array<{ id: number; direction: string; channel: string; content: string; created_at: string }>> {
    const lim = Math.min(Math.max(limit, 1), 1000);
    const [rows] = await this.pool.query(
      `SELECT id,direction,channel,content,created_at FROM bz_messages WHERE thread_id=? AND id>? ORDER BY id ASC LIMIT ${lim}`,
      [threadId, afterId],
    );
    return (rows as any[]).map((r) => ({ id: Number(r.id), direction: r.direction, channel: r.channel, content: r.content, created_at: new Date(r.created_at).toISOString() }));
  }

  async writeThreadSummary(threadId: number, summary: string, newWatermark: number, expectedWatermark: number): Promise<boolean> {
    const [res]: any = await this.pool.query(
      'UPDATE bz_threads SET summary=?, summary_upto_id=?, summary_updated_at=? WHERE thread_id=? AND summary_upto_id=?',
      [summary, newWatermark, dt(), threadId, expectedWatermark],
    );
    return Number(res?.affectedRows ?? 0) > 0;
  }

  async findThread(routeKey: string, scopeKey: string): Promise<number | null> {
    const [rows] = await this.pool.query(
      'SELECT thread_id FROM bz_threads WHERE route_key=? AND scope_key=? LIMIT 1',
      [routeKey, scopeKey],
    );
    return rows[0] ? Number(rows[0].thread_id) : null;
  }

  async threadMessages(threadId: number, n = 50): Promise<Array<{ direction: string; content: string; job_id: string | null; created_at: string }>> {
    const [rows] = await this.pool.query(
      `SELECT direction,content,job_id,created_at FROM bz_messages WHERE thread_id=? ORDER BY id DESC LIMIT ${Math.min(Math.max(n, 1), 100)}`,
      [threadId],
    );
    return (rows as any[]).reverse().map((r) => ({
      direction: r.direction, content: r.content, job_id: r.job_id ?? null,
      created_at: new Date(r.created_at).toISOString(),
    }));
  }

  async messagesForJob(jobId: string): Promise<Array<{ direction: string; channel: string; content: string; created_at: string }>> {
    const [rows] = await this.pool.query(
      'SELECT direction,channel,content,created_at FROM bz_messages WHERE job_id=? ORDER BY id ASC LIMIT 50',
      [jobId],
    );
    return (rows as any[]).map((m) => ({
      direction: m.direction, channel: m.channel, content: m.content, created_at: new Date(m.created_at).toISOString(),
    }));
  }

  async listRecentThreads(limit = 80, offset = 0): Promise<any[]> {
    const n = Math.min(Math.max(Number(limit) || 80, 1), 300);
    const off = Math.max(Math.floor(Number(offset) || 0), 0);
    const [rows] = await this.pool.query(
      'SELECT t.thread_id,t.route_key,t.scope_key,t.principal_id,t.message_count,t.created_at,t.last_active_at,' +
        'r.name AS route_name,' +
        "(SELECT m.channel FROM bz_messages m WHERE m.thread_id=t.thread_id AND m.direction='in' ORDER BY m.id DESC LIMIT 1) AS channel," +
        "(SELECT c.name FROM bz_clients c JOIN bz_messages m ON m.channel=c.app_id WHERE m.thread_id=t.thread_id AND m.direction='in' ORDER BY m.id DESC LIMIT 1) AS client_name," +
        "(SELECT e.name FROM bz_chat_entries e JOIN bz_messages m ON m.channel=CONCAT('chat:',e.entry_key) WHERE m.thread_id=t.thread_id AND m.direction='in' ORDER BY m.id DESC LIMIT 1) AS entry_name," +
        '(SELECT LEFT(m.content,140) FROM bz_messages m WHERE m.thread_id=t.thread_id ORDER BY m.id DESC LIMIT 1) AS last_preview ' +
        `FROM bz_threads t LEFT JOIN bz_routes r ON r.route_key=t.route_key ORDER BY t.last_active_at DESC LIMIT ${n} OFFSET ${off}`,
    );
    return (rows as any[]).map(rowThreadHead);
  }

  async threadDetail(threadId: number): Promise<{ thread: any; messages: any[] } | null> {
    const [trows] = await this.pool.query(
      'SELECT t.thread_id,t.route_key,t.scope_key,t.principal_id,t.message_count,t.created_at,t.last_active_at,t.summary,' +
        'r.name AS route_name,' +
        "(SELECT m.channel FROM bz_messages m WHERE m.thread_id=t.thread_id AND m.direction='in' ORDER BY m.id DESC LIMIT 1) AS channel," +
        "(SELECT c.name FROM bz_clients c JOIN bz_messages m ON m.channel=c.app_id WHERE m.thread_id=t.thread_id AND m.direction='in' ORDER BY m.id DESC LIMIT 1) AS client_name," +
        "(SELECT e.name FROM bz_chat_entries e JOIN bz_messages m ON m.channel=CONCAT('chat:',e.entry_key) WHERE m.thread_id=t.thread_id AND m.direction='in' ORDER BY m.id DESC LIMIT 1) AS entry_name " +
        'FROM bz_threads t LEFT JOIN bz_routes r ON r.route_key=t.route_key WHERE t.thread_id=? LIMIT 1',
      [threadId],
    );
    const t = (trows as any[])[0];
    if (!t) return null;
    const [mrows] = await this.pool.query(
      'SELECT id,direction,channel,principal_id,job_id,content,created_at FROM bz_messages WHERE thread_id=? ORDER BY id ASC LIMIT 1000',
      [threadId],
    );
    const messages = (mrows as any[]).map((m) => ({
      id: Number(m.id), direction: m.direction, channel: m.channel, principal_id: m.principal_id ?? null,
      job_id: m.job_id ?? null, content: m.content, created_at: new Date(m.created_at).toISOString(),
    }));
    return { thread: { ...rowThreadHead(t), summary: t.summary ?? null }, messages };
  }
}
