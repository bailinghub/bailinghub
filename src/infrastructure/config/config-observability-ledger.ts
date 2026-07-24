import { dtAt, traceSeverityValue, traceStageValue } from '../../core/config/config-codec';
import type { TraceSeverity, TraceStage } from '../../core/contracts/types';
import type { ControlPlaneOperationalMetricsSnapshot } from '../../core/observability/openmetrics';

export class ObservabilityLedger {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async listSchemaMigrations(): Promise<string[]> {
    const [rows] = await this.pool.query('SELECT filename FROM bz_schema_migrations ORDER BY filename');
    return (rows as Array<{ filename: string }>).map((r) => String(r.filename));
  }

  async countAuditEvents(jobId: string, event: string): Promise<number> {
    const [rows] = await this.pool.query('SELECT COUNT(*) AS n FROM bz_audit WHERE job_id=? AND event=?', [jobId, event]);
    return Number((rows as any[])[0]?.n ?? 0);
  }

  async monitorSnapshot(): Promise<{ errors_15m: number; oldest_queued_min: number }> {
    const cutoff = dtAt(Date.now() - 15 * 60_000);
    const [e] = await this.pool.query("SELECT COUNT(*) AS n FROM bz_jobs WHERE status='error' AND updated_at > ?", [cutoff]);
    const [q] = await this.pool.query("SELECT MIN(created_at) AS oldest FROM bz_jobs WHERE status='queued' AND COALESCE(source,'') <> 'monitor'");
    const oldestRaw = (q as any[])[0]?.oldest;
    const oldestMs = oldestRaw ? new Date(oldestRaw).getTime() : 0;
    return {
      errors_15m: Number((e as any[])[0]?.n ?? 0),
      oldest_queued_min: oldestMs ? Math.max(Math.floor((Date.now() - oldestMs) / 60_000), 0) : 0,
    };
  }

  async operationalMetricsSnapshot(nowMs = Date.now()): Promise<ControlPlaneOperationalMetricsSnapshot> {
    const onlineCutoff = dtAt(nowMs - 2 * 60_000);
    const [rows] = await this.pool.query(
      `SELECT
        (SELECT COUNT(*) FROM bz_tool_approvals WHERE status='pending') AS pending_approvals,
        (SELECT COUNT(*) FROM bz_executors WHERE last_seen_at>=?) AS executors_online,
        (SELECT COUNT(*) FROM bz_executors WHERE last_seen_at<? OR last_seen_at IS NULL) AS executors_offline`,
      [onlineCutoff, onlineCutoff],
    );
    const row = (rows as any[])[0] ?? {};
    const count = (value: unknown): number => Math.max(Number(value) || 0, 0);
    return {
      pendingApprovals: count(row.pending_approvals),
      executorsOnline: count(row.executors_online),
      executorsOffline: count(row.executors_offline),
    };
  }

  async recentConfigAudit(limit = 100, offset = 0): Promise<Array<{ ts: string; by: string; method: string; path: string }>> {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(Math.floor(Number(offset) || 0), 0);
    const [rows] = await this.pool.query(
      `SELECT ts,detail FROM bz_audit WHERE request_id='config' AND event='config_change' ORDER BY id DESC LIMIT ${n} OFFSET ${off}`,
    );
    return (rows as any[]).map((r) => {
      const d = r.detail ? (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) : {};
      return { ts: new Date(r.ts).toISOString(), by: String(d.by ?? '?'), method: String(d.method ?? '?'), path: String(d.path ?? '?') };
    });
  }

  async auditForJob(jobId: string): Promise<Array<{ ts: string; event: string; stage: TraceStage; severity: TraceSeverity; title: string; summary: string; detail: unknown }>> {
    const [rows] = await this.pool.query('SELECT ts,event,stage,severity,title,summary,detail FROM bz_audit WHERE job_id=? ORDER BY id LIMIT 100', [jobId]);
    return (rows as any[]).map((r) => ({
      ts: new Date(r.ts).toISOString(), event: r.event,
      stage: traceStageValue(r.stage),
      severity: traceSeverityValue(r.severity),
      title: r.title,
      summary: r.summary,
      detail: r.detail ? (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) : {},
    }));
  }

  async listRecentJobs(limit = 50, offset = 0): Promise<any[]> {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Math.floor(Number(offset) || 0), 0);
    const [rows] = await this.pool.query(
      'SELECT job_id,request_id,status,target,profile,project,source,client_app_id,session_id,input_preview,' +
        'JSON_UNQUOTE(JSON_EXTRACT(metadata,"$.visitor_uid")) AS visitor_uid,' +
        'JSON_UNQUOTE(JSON_EXTRACT(metadata,"$.thread_id")) AS thread_id,' +
        'JSON_UNQUOTE(JSON_EXTRACT(result,"$.report.severity")) AS severity,' +
        'COALESCE(JSON_UNQUOTE(JSON_EXTRACT(result,"$.report.summary")), LEFT(JSON_UNQUOTE(JSON_EXTRACT(result,"$.text")),200)) AS summary,' +
        `created_at,updated_at FROM bz_jobs ORDER BY created_at DESC LIMIT ${n} OFFSET ${off}`,
    );
    return rows as any[];
  }

  async findJobs(filter: { requestId?: string; clientAppId?: string; threadId?: number; principalId?: string; limit?: number }): Promise<any[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.requestId) { where.push('request_id = ?'); params.push(filter.requestId); }
    if (filter.clientAppId) { where.push('client_app_id = ?'); params.push(filter.clientAppId); }
    if (filter.threadId !== undefined) { where.push('thread_id = ?'); params.push(filter.threadId); }
    if (filter.principalId) {
      where.push("(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.principal.id')) = ? OR JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.principal_id')) = ?)");
      params.push(filter.principalId, filter.principalId);
    }
    if (!where.length) return [];
    const n = Math.min(Math.max(Number(filter.limit) || 20, 1), 100);
    const [rows] = await this.pool.query(
      'SELECT job_id,request_id,status,target,profile,project,source,client_app_id,thread_id,session_id,input_preview,' +
        'JSON_UNQUOTE(JSON_EXTRACT(dispatch,"$.route_key")) AS route_key,' +
        'JSON_UNQUOTE(JSON_EXTRACT(dispatch,"$.route_name")) AS route_name,' +
        'JSON_EXTRACT(metadata,"$.principal") AS principal,' +
        'created_at,updated_at FROM bz_jobs WHERE ' + where.join(' AND ') + ` ORDER BY created_at DESC LIMIT ${n}`,
      params,
    );
    return rows as any[];
  }

  async dispatchStatus(): Promise<{
    now: string;
    summary: {
      queued: number;
      running: number;
      dispatched: number;
      delayed_queued: number;
      expired_leases: number;
      blocked_threads: number;
    };
    by_target: Array<{ target: string; queued: number; running: number; dispatched: number }>;
    leases: Array<{
      job_id: string; request_id: string; status: string; target: string; executor_id?: string;
      thread_id?: number; client_app_id?: string; claimed_at?: string; lease_until?: string;
      dispatched_at?: string; created_at: string; updated_at: string; lease_ttl_sec?: number;
    }>;
    blocked_threads: Array<{ thread_id: number; queued: number; oldest_queued_at: string; inflight: string; inflight_jobs: string[] }>;
  }> {
    const nowMs = Date.now();
    const iso = (v: unknown): string | undefined => v ? new Date(v as string).toISOString() : undefined;
    const [statusRows] = await this.pool.query(
      "SELECT status,COUNT(*) AS n FROM bz_jobs WHERE status IN ('queued','running','dispatched') GROUP BY status",
    );
    const statusCount = new Map((statusRows as any[]).map((r) => [String(r.status), Number(r.n) || 0]));
    const [delayedRows] = await this.pool.query(
      "SELECT COUNT(*) AS n FROM bz_jobs WHERE status='queued' AND run_after IS NOT NULL AND run_after > UTC_TIMESTAMP()",
    );
    const [targetRows] = await this.pool.query(
      "SELECT COALESCE(target,'(无)') AS target,status,COUNT(*) AS n FROM bz_jobs WHERE status IN ('queued','running','dispatched') GROUP BY COALESCE(target,'(无)'),status ORDER BY target",
    );
    const byTarget = new Map<string, { target: string; queued: number; running: number; dispatched: number }>();
    for (const r of targetRows as any[]) {
      const target = String(r.target);
      const row = byTarget.get(target) ?? { target, queued: 0, running: 0, dispatched: 0 };
      const status = String(r.status);
      if (status === 'queued' || status === 'running' || status === 'dispatched') row[status] = Number(r.n) || 0;
      byTarget.set(target, row);
    }
    const [leaseRows] = await this.pool.query(
      "SELECT job_id,request_id,status,target,executor_id,thread_id,client_app_id,claimed_at,lease_until,dispatched_at,created_at,updated_at " +
        "FROM bz_jobs WHERE status IN ('running','dispatched') ORDER BY COALESCE(lease_until,updated_at),created_at LIMIT 200",
    );
    const leases = (leaseRows as any[]).map((r) => {
      const leaseMs = r.lease_until ? new Date(r.lease_until).getTime() : undefined;
      return {
        job_id: r.job_id,
        request_id: r.request_id,
        status: r.status,
        target: r.target ?? '(无)',
        executor_id: r.executor_id ?? undefined,
        thread_id: r.thread_id != null ? Number(r.thread_id) : undefined,
        client_app_id: r.client_app_id ?? undefined,
        claimed_at: iso(r.claimed_at),
        lease_until: iso(r.lease_until),
        dispatched_at: iso(r.dispatched_at),
        created_at: iso(r.created_at)!,
        updated_at: iso(r.updated_at)!,
        lease_ttl_sec: leaseMs ? Math.floor((leaseMs - nowMs) / 1000) : undefined,
      };
    });
    const expiredLeases = leases.filter((l) => l.lease_ttl_sec !== undefined && l.lease_ttl_sec < 0).length;
    const [blockedRows] = await this.pool.query(
      "SELECT q.thread_id,COUNT(*) AS queued,MIN(q.created_at) AS oldest_queued_at," +
        "GROUP_CONCAT(DISTINCT CONCAT(i.status,':',COALESCE(i.executor_id,'')) ORDER BY i.status SEPARATOR ', ') AS inflight," +
        "GROUP_CONCAT(DISTINCT i.job_id ORDER BY i.created_at SEPARATOR ',') AS inflight_jobs " +
        "FROM bz_jobs q JOIN bz_jobs i ON i.thread_id=q.thread_id AND i.status IN ('running','dispatched') " +
        "WHERE q.status='queued' AND q.thread_id IS NOT NULL GROUP BY q.thread_id ORDER BY oldest_queued_at LIMIT 100",
    );
    const blockedThreads = (blockedRows as any[]).map((r) => ({
      thread_id: Number(r.thread_id),
      queued: Number(r.queued) || 0,
      oldest_queued_at: iso(r.oldest_queued_at)!,
      inflight: String(r.inflight ?? ''),
      inflight_jobs: String(r.inflight_jobs ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10),
    }));
    return {
      now: new Date(nowMs).toISOString(),
      summary: {
        queued: statusCount.get('queued') ?? 0,
        running: statusCount.get('running') ?? 0,
        dispatched: statusCount.get('dispatched') ?? 0,
        delayed_queued: Number((delayedRows as any[])[0]?.n ?? 0),
        expired_leases: expiredLeases,
        blocked_threads: blockedThreads.length,
      },
      by_target: Array.from(byTarget.values()).sort((a, b) => a.target.localeCompare(b.target)),
      leases,
      blocked_threads: blockedThreads,
    };
  }

  async costSummary(days = 30): Promise<{
    days: number;
    total: { jobs: number; cost_usd: number; tokens: number };
    by_day: Array<{ day: string; jobs: number; cost_usd: number }>;
    by_target: Array<{ target: string; jobs: number; cost_usd: number }>;
    by_route: Array<{ route: string; jobs: number; cost_usd: number }>;
  }> {
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    const since = dtAt(Date.now() - d * 86400_000);
    const COST = "CAST(JSON_EXTRACT(`usage`,'$.cost_usd') AS DECIMAL(18,6))";
    const TOK = "CAST(JSON_EXTRACT(`usage`,'$.tokens') AS UNSIGNED)";
    const num = (v: unknown): number => Number(v) || 0;
    const [tot] = await this.pool.query(
      `SELECT COUNT(*) AS jobs, COALESCE(SUM(${COST}),0) AS cost, COALESCE(SUM(${TOK}),0) AS tokens FROM bz_jobs WHERE created_at >= ?`,
      [since],
    );
    const [byDay] = await this.pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS jobs, COALESCE(SUM(${COST}),0) AS cost FROM bz_jobs WHERE created_at >= ? GROUP BY DATE(created_at) ORDER BY day DESC LIMIT 366`,
      [since],
    );
    const [byTarget] = await this.pool.query(
      `SELECT COALESCE(target,'(无)') AS target, COUNT(*) AS jobs, COALESCE(SUM(${COST}),0) AS cost FROM bz_jobs WHERE created_at >= ? GROUP BY target ORDER BY cost DESC LIMIT 50`,
      [since],
    );
    const [byRoute] = await this.pool.query(
      `SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(dispatch,'$.route_name')),'(未命名)') AS route, COUNT(*) AS jobs, COALESCE(SUM(${COST}),0) AS cost FROM bz_jobs WHERE created_at >= ? GROUP BY route ORDER BY cost DESC LIMIT 50`,
      [since],
    );
    const t0 = (tot as any[])[0] ?? {};
    const day = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 10) : new Date(v as string).toISOString().slice(0, 10));
    return {
      days: d,
      total: { jobs: num(t0.jobs), cost_usd: num(t0.cost), tokens: num(t0.tokens) },
      by_day: (byDay as any[]).map((r) => ({ day: day(r.day), jobs: num(r.jobs), cost_usd: num(r.cost) })),
      by_target: (byTarget as any[]).map((r) => ({ target: String(r.target), jobs: num(r.jobs), cost_usd: num(r.cost) })),
      by_route: (byRoute as any[]).map((r) => ({ route: String(r.route), jobs: num(r.jobs), cost_usd: num(r.cost) })),
    };
  }

  async budgetUsageSince(filter: { routeKey?: string; clientAppId?: string; sinceMs: number }): Promise<{ jobs: number; cost_usd: number; tokens: number }> {
    const since = dtAt(filter.sinceMs);
    const COST = "CAST(JSON_EXTRACT(`usage`,'$.cost_usd') AS DECIMAL(18,6))";
    const TOK = "CAST(JSON_EXTRACT(`usage`,'$.tokens') AS UNSIGNED)";
    const where: string[] = ['created_at >= ?', '`usage` IS NOT NULL'];
    const params: unknown[] = [since];
    if (filter.routeKey) {
      where.push("JSON_UNQUOTE(JSON_EXTRACT(dispatch,'$.route_key')) = ?");
      params.push(filter.routeKey);
    }
    if (filter.clientAppId) {
      where.push('client_app_id = ?');
      params.push(filter.clientAppId);
    }
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) AS jobs, COALESCE(SUM(${COST}),0) AS cost, COALESCE(SUM(${TOK}),0) AS tokens FROM bz_jobs WHERE ${where.join(' AND ')}`,
      params,
    );
    const r = (rows as any[])[0] ?? {};
    return { jobs: Number(r.jobs) || 0, cost_usd: Number(r.cost) || 0, tokens: Number(r.tokens) || 0 };
  }
}
