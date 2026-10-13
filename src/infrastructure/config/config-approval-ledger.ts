import { dt, rowToolApproval } from '../../core/config/config-codec';
import type { ToolApproval } from '../../core/contracts/types';
import type { ApprovalContinuation, ApprovalContinuationDecisionOptions } from '../../core/contracts/approval-continuation';

export class ApprovalLedger {
  private continuationCursor = 0;
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async create(a: Omit<ToolApproval, 'id' | 'status' | 'created_at'>): Promise<number> {
    const [r]: any = await this.pool.query(
      'INSERT INTO bz_tool_approvals (job_id,request_id,provider,tool,scope,risk,policy,reason,method,path,summary,args_json,args_hash,intent_json,on_behalf_of,status,created_at) ' +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)",
      [a.job_id, a.request_id, a.provider, a.tool, a.scope, a.risk, a.policy ?? null, a.reason ?? null,
       a.method ?? null, a.path ?? null, a.summary ?? null, a.args_json ?? null, a.args_hash,
       a.intent_json ?? (a.intent ? JSON.stringify(a.intent) : null), a.on_behalf_of ?? null, dt()],
    );
    return Number(r.insertId);
  }

  async find(jobId: string, tool: string, argsHash: string, status: string, unusedOnly = false): Promise<ToolApproval | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM bz_tool_approvals WHERE job_id=? AND tool=? AND args_hash=? AND status=?${unusedOnly ? ' AND used_at IS NULL' : ''} ORDER BY id DESC LIMIT 1`,
      [jobId, tool, argsHash, status],
    );
    return rows[0] ? rowToolApproval(rows[0]) : null;
  }

  async get(id: number): Promise<ToolApproval | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_tool_approvals WHERE id=? LIMIT 1', [id]);
    return rows[0] ? rowToolApproval(rows[0]) : null;
  }

  async getByDecisionId(decisionId: string): Promise<ToolApproval | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_tool_approvals WHERE decision_id=? LIMIT 1', [decisionId]);
    return rows[0] ? rowToolApproval(rows[0]) : null;
  }

  async decide(id: number, status: 'approved' | 'denied', decidedBy: string, opts?: { decision_id?: string; comment?: string }): Promise<boolean> {
    const [r]: any = await this.pool.query(
      "UPDATE bz_tool_approvals SET status=?, decided_by=?, decision_id=?, decision_comment=?, decided_at=? WHERE id=? AND status='pending'",
      [status, decidedBy, opts?.decision_id ?? null, opts?.comment ?? null, dt(), id],
    );
    return r?.affectedRows === 1;
  }

  /** Decision and immutable follow-up coordinates are a single database transaction. */
  async decideWithContinuation(id: number, status: 'approved' | 'denied', decidedBy: string,
    opts: ApprovalContinuationDecisionOptions): Promise<'decided' | 'same' | 'conflict'> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows]: any = await conn.query('SELECT * FROM bz_tool_approvals WHERE id=? FOR UPDATE', [id]);
      if (!rows[0]) { await conn.commit(); return 'conflict'; }
      const approval = rowToolApproval(rows[0]);
      if (approval.status !== 'pending') {
        const same = approval.status === status && (approval.decision_id ?? null) === (opts.decision_id ?? null);
        await conn.commit();
        return same ? 'same' : 'conflict';
      }
      const intent: ApprovalContinuation = {
        schema_version: 'bailing.approval-continuation.v1', approval_id: id,
        decision_key: opts.decision_id ?? `console:${id}`, decision: status,
        ...(opts.decision_id ? { decision_id: opts.decision_id } : {}),
        job_id: approval.job_id, request_id: approval.request_id, args_hash: approval.args_hash,
        tool: approval.tool, scope: approval.scope, by: decidedBy,
        source: opts.source, auth: opts.auth, mode: opts.mode,
        ...(approval.policy ? { policy: approval.policy } : {}),
        ...(approval.reason ? { reason: approval.reason } : {}),
        ...(approval.summary ? { summary: approval.summary } : {}),
        ...(opts.comment ? { comment: opts.comment } : {}),
        audit_recorded: false, completed: false,
      };
      await conn.query("UPDATE bz_tool_approvals SET status=?,decided_by=?,decision_id=?,decision_comment=?,decided_at=? WHERE id=? AND status='pending'",
        [status, decidedBy, opts.decision_id ?? null, opts.comment ?? null, dt(), id]);
      await conn.query('INSERT INTO bz_approval_continuations (approval_id,intent_json,created_at) VALUES (?,?,?)',
        [id, JSON.stringify(intent), dt()]);
      await conn.commit();
      return 'decided';
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return 'conflict';
      throw error;
    } finally { conn.release(); }
  }

  async getContinuation(id: number): Promise<ApprovalContinuation | null> {
    const [rows]: any = await this.pool.query('SELECT * FROM bz_approval_continuations WHERE approval_id=?', [id]);
    return rows[0] ? continuationRow(rows[0]) : null;
  }

  async pendingContinuations(limit = 25): Promise<ApprovalContinuation[]> {
    const n = Math.min(Math.max(Math.trunc(limit) || 25, 1), 100);
    let [rows]: any = await this.pool.query(`SELECT * FROM bz_approval_continuations WHERE completed_at IS NULL AND approval_id>? ORDER BY approval_id LIMIT ${n}`, [this.continuationCursor]);
    if (!rows.length && this.continuationCursor > 0) {
      this.continuationCursor = 0;
      [rows] = await this.pool.query(`SELECT * FROM bz_approval_continuations WHERE completed_at IS NULL AND approval_id>? ORDER BY approval_id LIMIT ${n}`, [0]);
    }
    if (rows.length) this.continuationCursor = Number(rows[rows.length - 1].approval_id);
    return rows.map(continuationRow);
  }

  async markContinuationAuditRecorded(id: number, decisionKey: string): Promise<void> {
    await this.pool.query("UPDATE bz_approval_continuations SET audit_recorded_at=COALESCE(audit_recorded_at,?) WHERE approval_id=? AND JSON_UNQUOTE(JSON_EXTRACT(intent_json,'$.decision_key'))=?",
      [dt(), id, decisionKey]);
  }

  async completeContinuation(id: number, decisionKey: string): Promise<void> {
    await this.pool.query("UPDATE bz_approval_continuations SET completed_at=COALESCE(completed_at,?) WHERE approval_id=? AND audit_recorded_at IS NOT NULL AND JSON_UNQUOTE(JSON_EXTRACT(intent_json,'$.decision_key'))=?",
      [dt(), id, decisionKey]);
  }

  async use(id: number): Promise<boolean> {
    const [r]: any = await this.pool.query(
      "UPDATE bz_tool_approvals SET used_at=? WHERE id=? AND status='approved' AND used_at IS NULL",
      [dt(), id],
    );
    return r?.affectedRows === 1;
  }

  async list(status?: string, limit = 50): Promise<ToolApproval[]> {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const [rows] = status
      ? await this.pool.query(`SELECT * FROM bz_tool_approvals WHERE status=? ORDER BY id DESC LIMIT ${n}`, [status])
      : await this.pool.query(`SELECT * FROM bz_tool_approvals ORDER BY id DESC LIMIT ${n}`);
    return (rows as any[]).map(rowToolApproval);
  }

  async approvedUnusedForJob(jobId: string): Promise<ToolApproval[]> {
    const [rows] = await this.pool.query(
      "SELECT * FROM bz_tool_approvals WHERE job_id=? AND status='approved' AND used_at IS NULL ORDER BY id",
      [jobId],
    );
    return (rows as any[]).map(rowToolApproval);
  }

  async forJob(jobId: string): Promise<ToolApproval[]> {
    const [rows] = await this.pool.query('SELECT * FROM bz_tool_approvals WHERE job_id=? ORDER BY id', [jobId]);
    return (rows as any[]).map(rowToolApproval);
  }

  async forJobs(jobIds: string[]): Promise<Record<string, ToolApproval[]>> {
    const ids = [...new Set(jobIds.map(String).filter(Boolean))].slice(0, 100);
    const grouped: Record<string, ToolApproval[]> = Object.fromEntries(ids.map((id) => [id, []]));
    if (!ids.length) return grouped;
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await this.pool.query(
      `SELECT * FROM bz_tool_approvals WHERE job_id IN (${placeholders}) ORDER BY id`,
      ids,
    );
    for (const row of rows as any[]) {
      const jobId = String(row.job_id);
      if (grouped[jobId]) grouped[jobId]!.push(rowToolApproval(row));
    }
    return grouped;
  }
}

function continuationRow(row: any): ApprovalContinuation {
  const intent = typeof row.intent_json === 'string' ? JSON.parse(row.intent_json) : row.intent_json;
  if (!intent || intent.schema_version !== 'bailing.approval-continuation.v1'
    || intent.approval_id !== Number(row.approval_id)) throw new Error('approval_continuation_invalid');
  return { ...intent, audit_recorded: row.audit_recorded_at != null, completed: row.completed_at != null };
}
