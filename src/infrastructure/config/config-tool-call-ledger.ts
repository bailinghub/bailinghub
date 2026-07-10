import { dt, dtAt } from '../../core/config/config-codec';

export class ToolCallLedger {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async get(jobId: string, tool: string, argsHash: string): Promise<{ ok: boolean; status: number; text: string } | null> {
    const [rows] = await this.pool.query('SELECT ok,status,result_json FROM bz_tool_calls WHERE job_id=? AND tool=? AND args_hash=? LIMIT 1', [jobId, tool, argsHash]);
    const r = (rows as any[])[0];
    if (!r) return null;
    let text = '';
    try { text = r.result_json ? String(JSON.parse(r.result_json).text ?? '') : ''; } catch { /* 坏行当空文本 */ }
    return { ok: !!r.ok, status: Number(r.status ?? 0), text };
  }

  async put(jobId: string, tool: string, argsHash: string, res: { ok: boolean; status: number; text: string }): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_tool_calls (job_id,tool,args_hash,ok,status,result_json,created_at) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id',
      [jobId, tool, argsHash, res.ok ? 1 : 0, res.status, JSON.stringify({ text: res.text ?? '' }), dt()],
    );
  }

  async cleanup(olderThanMs: number): Promise<number> {
    const [r]: any = await this.pool.query('DELETE FROM bz_tool_calls WHERE created_at < ?', [dtAt(Date.now() - olderThanMs)]);
    return r?.affectedRows ?? 0;
  }
}
