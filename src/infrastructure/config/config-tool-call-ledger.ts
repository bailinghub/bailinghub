import { dt, dtAt } from '../../core/config/config-codec';
import type {
  ToolExecutionJournalEntry,
  ToolExecutionJournalRecord,
  ToolExecutionJournalState,
} from '../../core/contracts/tools';

export class ToolCallLedger {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async get(jobId: string, tool: string, argsHash: string): Promise<ToolExecutionJournalEntry | null> {
    const [rows] = await this.pool.query(
      'SELECT state,ok,status,result_json,idempotency_key,error FROM bz_tool_calls WHERE job_id=? AND tool=? AND args_hash=? LIMIT 1',
      [jobId, tool, argsHash],
    );
    const r = (rows as any[])[0];
    if (!r) return null;
    return decodeEntry(r);
  }

  async findUnresolved(jobId: string): Promise<ToolExecutionJournalRecord | null> {
    const [rows] = await this.pool.query(
      `SELECT job_id,tool,scope,args_hash,state,ok,status,result_json,idempotency_key,error
       FROM bz_tool_calls
       WHERE job_id=? AND state<>'completed'
       ORDER BY id ASC LIMIT 1`,
      [jobId],
    );
    const r = (rows as any[])[0];
    if (!r) return null;
    return {
      ...decodeEntry(r),
      jobId: String(r.job_id),
      tool: String(r.tool),
      scope: String(r.scope ?? ''),
      argsHash: String(r.args_hash),
    };
  }

  async reserve(jobId: string, tool: string, scope: string, argsHash: string, idempotencyKey: string): Promise<{ inserted: boolean; entry: ToolExecutionJournalEntry }> {
    const now = dt();
    const [result]: any = await this.pool.query(
      `INSERT IGNORE INTO bz_tool_calls
        (job_id,tool,scope,args_hash,state,idempotency_key,ok,status,result_json,error,created_at,updated_at)
       VALUES (?,?,?,?,'dispatching',?,0,0,NULL,NULL,?,?)`,
      [jobId, tool, scope, argsHash, idempotencyKey, now, now],
    );
    const inserted = Number(result?.affectedRows ?? 0) === 1;
    const entry = inserted
      ? { state: 'dispatching' as const, ok: false, status: 0, text: '', idempotencyKey }
      : await this.get(jobId, tool, argsHash);
    if (!entry) throw new Error('tool_execution_reservation_missing');
    return { inserted, entry };
  }

  async recordResponse(jobId: string, tool: string, argsHash: string, res: { ok: boolean; status: number; text: string }): Promise<void> {
    const [result]: any = await this.pool.query(
      `UPDATE bz_tool_calls
       SET state='response_recorded',ok=?,status=?,result_json=?,error=NULL,updated_at=?
       WHERE job_id=? AND tool=? AND args_hash=? AND state='dispatching'`,
      [res.ok ? 1 : 0, res.status, JSON.stringify({ text: res.text ?? '' }), dt(), jobId, tool, argsHash],
    );
    if (Number(result?.affectedRows ?? 0) !== 1) throw new Error('tool_execution_response_transition_failed');
  }

  async complete(jobId: string, tool: string, argsHash: string): Promise<void> {
    const [result]: any = await this.pool.query(
      `UPDATE bz_tool_calls SET state='completed',error=NULL,updated_at=?
       WHERE job_id=? AND tool=? AND args_hash=? AND state='response_recorded'`,
      [dt(), jobId, tool, argsHash],
    );
    if (Number(result?.affectedRows ?? 0) !== 1) throw new Error('tool_execution_complete_transition_failed');
  }

  async markUncertain(jobId: string, tool: string, argsHash: string, error: string): Promise<void> {
    await this.markState(jobId, tool, argsHash, 'uncertain', error);
  }

  async markEvidenceDegraded(jobId: string, tool: string, argsHash: string, error: string): Promise<void> {
    await this.markState(jobId, tool, argsHash, 'evidence_degraded', error);
  }

  /** 兼容旧调用方的成功后登记入口；受治理副作用必须使用 reserve/recordResponse/complete 三阶段日志。 */
  async put(jobId: string, tool: string, argsHash: string, res: { ok: boolean; status: number; text: string }): Promise<void> {
    const now = dt();
    await this.pool.query(
      `INSERT INTO bz_tool_calls
        (job_id,tool,args_hash,state,idempotency_key,ok,status,result_json,error,created_at,updated_at)
       VALUES (?,?,?,'completed','',?,?,?,NULL,?,?)
       ON DUPLICATE KEY UPDATE id=id`,
      [jobId, tool, argsHash, res.ok ? 1 : 0, res.status, JSON.stringify({ text: res.text ?? '' }), now, now],
    );
  }

  async cleanup(olderThanMs: number): Promise<number> {
    const [r]: any = await this.pool.query(
      `DELETE FROM bz_tool_calls
       WHERE state='completed' AND COALESCE(updated_at,created_at) < ?`,
      [dtAt(Date.now() - olderThanMs)],
    );
    return r?.affectedRows ?? 0;
  }

  private async markState(jobId: string, tool: string, argsHash: string, state: 'uncertain' | 'evidence_degraded', error: string): Promise<void> {
    const allowedFrom = state === 'uncertain' ? "('dispatching','response_recorded')" : "('response_recorded')";
    const [result]: any = await this.pool.query(
      `UPDATE bz_tool_calls SET state=?,error=?,updated_at=?
       WHERE job_id=? AND tool=? AND args_hash=? AND state IN ${allowedFrom}`,
      [state, error.slice(0, 500), dt(), jobId, tool, argsHash],
    );
    if (Number(result?.affectedRows ?? 0) !== 1) throw new Error(`tool_execution_${state}_transition_failed`);
  }
}

function decodeEntry(row: any): ToolExecutionJournalEntry {
  let text = '';
  try { text = row.result_json ? String(JSON.parse(row.result_json).text ?? '') : ''; } catch { /* 坏行当空文本 */ }
  const rawState = String(row.state ?? 'completed');
  const knownStates = new Set<ToolExecutionJournalState>([
    'dispatching',
    'response_recorded',
    'completed',
    'uncertain',
    'evidence_degraded',
  ]);
  const state: ToolExecutionJournalState = knownStates.has(rawState as ToolExecutionJournalState)
    ? rawState as ToolExecutionJournalState
    : 'uncertain';
  const unknownStateError = state === 'uncertain' && rawState !== 'uncertain'
    ? `unknown_tool_execution_state:${rawState}`
    : undefined;
  return {
    state,
    ok: !!row.ok,
    status: Number(row.status ?? 0),
    text,
    idempotencyKey: String(row.idempotency_key ?? ''),
    ...(row.error ? { error: String(row.error) } : unknownStateError ? { error: unknownStateError } : {}),
  };
}
