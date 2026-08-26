import { createHash, randomUUID } from 'node:crypto';
import { dt } from '../../core/config/config-codec';

export interface AgentClientRunRecord {
  run_id: string;
  session_id: string;
  client_app_id: string;
  route_key: string;
  thread_id: number;
  client_conversation_id: string;
  client_turn_id: string;
  user_message_id: string;
  request_hash: string;
  user_input: string;
  context: Record<string, unknown> | null;
  status: string;
  completion_hash: string | null;
  assistant_message_id: string | null;
  final_content: string | null;
  model: string | null;
  runtime: string | null;
  usage: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ReserveAgentClientRunInput {
  session_id: string;
  client_app_id: string;
  route_key: string;
  thread_id: number;
  client_conversation_id: string;
  client_turn_id: string;
  user_message_id: string;
  request_hash: string;
  user_input: string;
}

export class AgentClientRuntimeConflictError extends Error {
  override readonly name = 'AgentClientRuntimeConflictError';
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function iso(value: unknown): string | null {
  if (!value) return null;
  return new Date(value as string | number | Date).toISOString();
}

function runRow(row: any): AgentClientRunRecord {
  return {
    run_id: String(row.run_id), session_id: String(row.session_id), client_app_id: String(row.client_app_id),
    route_key: String(row.route_key), thread_id: Number(row.thread_id),
    client_conversation_id: String(row.client_conversation_id), client_turn_id: String(row.client_turn_id),
    user_message_id: String(row.user_message_id), request_hash: String(row.request_hash), user_input: String(row.user_input),
    context: parseJson(row.context_json), status: String(row.status), completion_hash: row.completion_hash ?? null,
    assistant_message_id: row.assistant_message_id ?? null,
    final_content: row.final_content ?? null, model: row.model ?? null, runtime: row.runtime ?? null,
    usage: parseJson(row.usage_json), created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)!, completed_at: iso(row.completed_at),
  };
}

/** Agent Client Runtime 的幂等与对话映射账本。所有可见消息仍落既有 bz_messages 总账。 */
export class AgentClientRuntimeRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async resolveConversation(input: {
    session_id: string;
    client_app_id: string;
    route_key: string;
    client_conversation_id: string;
    principal_id: string;
  }): Promise<number> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [found] = await conn.query(
        'SELECT thread_id,client_app_id FROM bz_agent_client_conversations WHERE session_id=? AND route_key=? AND client_conversation_id=? LIMIT 1 FOR UPDATE',
        [input.session_id, input.route_key, input.client_conversation_id],
      );
      if (found[0]) {
        if (String(found[0].client_app_id) !== input.client_app_id) throw new AgentClientRuntimeConflictError('conversation client binding changed');
        await conn.query(
          'UPDATE bz_agent_client_conversations SET last_active_at=? WHERE session_id=? AND route_key=? AND client_conversation_id=?',
          [dt(), input.session_id, input.route_key, input.client_conversation_id],
        );
        await conn.commit();
        return Number(found[0].thread_id);
      }
      const scope = `agent:${createHash('sha256').update(`${input.session_id}\0${input.route_key}\0${input.client_conversation_id}`).digest('hex')}`;
      const at = dt();
      await conn.query(
        'INSERT INTO bz_threads (route_key,scope_key,principal_id,message_count,created_at,last_active_at) VALUES (?,?,?,0,?,?) ON DUPLICATE KEY UPDATE last_active_at=VALUES(last_active_at)',
        [input.route_key, scope, input.principal_id || null, at, at],
      );
      const [threads] = await conn.query('SELECT thread_id FROM bz_threads WHERE route_key=? AND scope_key=? LIMIT 1', [input.route_key, scope]);
      const threadId = Number(threads[0]?.thread_id ?? 0);
      if (!threadId) throw new Error('failed to resolve Agent conversation thread');
      await conn.query(
        'INSERT INTO bz_agent_client_conversations (session_id,client_app_id,route_key,client_conversation_id,thread_id,created_at,last_active_at) VALUES (?,?,?,?,?,?,?)',
        [input.session_id, input.client_app_id, input.route_key, input.client_conversation_id, threadId, at, at],
      );
      await conn.commit();
      return threadId;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      if ((error as { code?: string })?.code === 'ER_DUP_ENTRY') {
        const [rows] = await this.pool.query(
          'SELECT thread_id,client_app_id FROM bz_agent_client_conversations WHERE session_id=? AND route_key=? AND client_conversation_id=? LIMIT 1',
          [input.session_id, input.route_key, input.client_conversation_id],
        );
        if (rows[0] && String(rows[0].client_app_id) === input.client_app_id) return Number(rows[0].thread_id);
      }
      throw error;
    } finally { conn.release(); }
  }

  async reserveRun(input: ReserveAgentClientRunInput): Promise<{ run: AgentClientRunRecord; created: boolean }> {
    const runId = randomUUID();
    const at = dt();
    try {
      await this.pool.query(
        'INSERT INTO bz_agent_client_runs (run_id,session_id,client_app_id,route_key,thread_id,client_conversation_id,client_turn_id,user_message_id,request_hash,user_input,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,\'preparing\',?,?)',
        [runId, input.session_id, input.client_app_id, input.route_key, input.thread_id, input.client_conversation_id, input.client_turn_id, input.user_message_id, input.request_hash, input.user_input, at, at],
      );
      const created = await this.getRun(runId, input.session_id, input.client_app_id);
      if (!created) throw new Error('failed to read newly created Agent run');
      return { run: created, created: true };
    } catch (error) {
      if ((error as { code?: string })?.code !== 'ER_DUP_ENTRY') throw error;
      const [rows] = await this.pool.query(
        'SELECT * FROM bz_agent_client_runs WHERE session_id=? AND route_key=? AND ((client_conversation_id=? AND client_turn_id=?) OR user_message_id=?) LIMIT 2',
        [input.session_id, input.route_key, input.client_conversation_id, input.client_turn_id, input.user_message_id],
      );
      const existing = (rows as any[]).find((row) => (
        String(row.client_app_id) === input.client_app_id
        && String(row.client_conversation_id) === input.client_conversation_id
        && String(row.client_turn_id) === input.client_turn_id
        && String(row.user_message_id) === input.user_message_id
        && String(row.request_hash) === input.request_hash
        && Number(row.thread_id) === input.thread_id
      ));
      if (!existing) throw new AgentClientRuntimeConflictError('turn id or user message id is already bound to different input');
      return { run: runRow(existing), created: false };
    }
  }

  async getRun(runId: string, sessionId: string, clientAppId: string): Promise<AgentClientRunRecord | null> {
    const [rows] = await this.pool.query(
      'SELECT * FROM bz_agent_client_runs WHERE run_id=? AND session_id=? AND client_app_id=? LIMIT 1',
      [runId, sessionId, clientAppId],
    );
    return rows[0] ? runRow(rows[0]) : null;
  }

  async findRunForInvocation(runId: string): Promise<AgentClientRunRecord | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_agent_client_runs WHERE run_id=? LIMIT 1', [runId]);
    return rows[0] ? runRow(rows[0]) : null;
  }

  async finalizeTurn(input: {
    run_id: string;
    session_id: string;
    client_app_id: string;
    request_hash: string;
    context: Record<string, unknown>;
    principal_id: string;
  }): Promise<AgentClientRunRecord> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM bz_agent_client_runs WHERE run_id=? FOR UPDATE', [input.run_id]);
      const row = rows[0];
      if (!row || String(row.session_id) !== input.session_id || String(row.client_app_id) !== input.client_app_id) {
        throw new AgentClientRuntimeConflictError('run ownership changed');
      }
      if (String(row.request_hash) !== input.request_hash) throw new AgentClientRuntimeConflictError('run input changed');
      if (row.context_json) { await conn.commit(); return runRow(row); }
      const at = dt();
      await conn.query(
        'INSERT INTO bz_messages (thread_id,direction,channel,principal_id,job_id,agent_run_id,external_message_id,content,created_at) VALUES (?,\'in\',?,?,?,?,?,?,?)',
        [Number(row.thread_id), `agent:${input.client_app_id}`, input.principal_id || null, null, input.run_id, String(row.user_message_id), String(row.user_input), at],
      );
      await conn.query('UPDATE bz_threads SET message_count=message_count+1,last_active_at=? WHERE thread_id=?', [at, Number(row.thread_id)]);
      await conn.query(
        'UPDATE bz_agent_client_runs SET context_json=?,status=\'context_ready\',updated_at=? WHERE run_id=?',
        [JSON.stringify(input.context), at, input.run_id],
      );
      const [updated] = await conn.query('SELECT * FROM bz_agent_client_runs WHERE run_id=? LIMIT 1', [input.run_id]);
      await conn.commit();
      return runRow(updated[0]);
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally { conn.release(); }
  }

  async completeRun(input: {
    run_id: string;
    session_id: string;
    client_app_id: string;
    completion_hash: string;
    assistant_message_id: string;
    status: string;
    assistant_output: string;
    model?: string;
    runtime?: string;
    usage?: Record<string, unknown>;
  }): Promise<{ run: AgentClientRunRecord; created: boolean }> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM bz_agent_client_runs WHERE run_id=? FOR UPDATE', [input.run_id]);
      const row = rows[0];
      if (!row || String(row.session_id) !== input.session_id || String(row.client_app_id) !== input.client_app_id) {
        throw new AgentClientRuntimeConflictError('run not found for this Agent Session');
      }
      if (!row.context_json) throw new AgentClientRuntimeConflictError('turn context is not ready');
      if (row.completion_hash) {
        if (String(row.completion_hash) !== input.completion_hash) throw new AgentClientRuntimeConflictError('run completion is immutable');
        await conn.commit();
        return { run: runRow(row), created: false };
      }
      const at = dt();
      await conn.query(
        'INSERT INTO bz_messages (thread_id,direction,channel,principal_id,job_id,agent_run_id,external_message_id,content,created_at) VALUES (?,\'out\',\'hub\',NULL,NULL,?,?,?,?)',
        [Number(row.thread_id), input.run_id, input.assistant_message_id, input.assistant_output, at],
      );
      await conn.query('UPDATE bz_threads SET message_count=message_count+1,last_active_at=? WHERE thread_id=?', [at, Number(row.thread_id)]);
      await conn.query(
        'UPDATE bz_agent_client_runs SET completion_hash=?,assistant_message_id=?,final_content=?,status=?,model=?,runtime=?,usage_json=?,updated_at=?,completed_at=? WHERE run_id=?',
        [input.completion_hash, input.assistant_message_id, input.assistant_output, input.status, input.model ?? null, input.runtime ?? null, input.usage ? JSON.stringify(input.usage) : null, at, at, input.run_id],
      );
      const [updated] = await conn.query('SELECT * FROM bz_agent_client_runs WHERE run_id=? LIMIT 1', [input.run_id]);
      await conn.commit();
      return { run: runRow(updated[0]), created: true };
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally { conn.release(); }
  }
}
