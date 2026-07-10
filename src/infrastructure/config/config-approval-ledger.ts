import { dt, rowToolApproval } from '../../core/config/config-codec';
import type { ToolApproval } from '../../core/contracts/types';

export class ApprovalLedger {
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
}
