import type { Job, ToolApproval, TraceSeverity, TraceStage } from '../contracts/types';
import { redactText } from './redaction-runtime';
import {
  traceSeverityOf,
  traceStageOf,
  traceSummaryOf,
  traceTitleOf,
  type RawTraceAudit,
} from './trace-runtime';

export type AgentClientTraceSource = 'local_agent' | 'hub_governance';

export interface AgentClientTraceRun {
  run_id: string;
  thread_id: number;
  client_app_id: string;
  route_key: string;
  status: string;
  model: string | null;
  runtime: string | null;
  usage: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AgentClientTraceToolInput {
  job: Job;
  audit: RawTraceAudit[];
  approvals: ToolApproval[];
}

export interface AgentClientTraceEvent {
  ts: string;
  event: string;
  stage: TraceStage;
  severity: TraceSeverity;
  title: string;
  summary: string;
  detail: Record<string, unknown>;
  source: AgentClientTraceSource;
  tool_job_id?: string;
}

const SAFE_USAGE_KEYS = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'total_tokens',
  'tool_calls',
  'cost_usd',
] as const;

const SAFE_AUDIT_KEYS = [
  'provider',
  'tool',
  'scope',
  'method',
  'path',
  'status',
  'ok',
  'duration_ms',
  'approval_id',
  'state',
  'business_status',
  'route',
  'invocation_id',
  'client_app_id',
  'agent_thread_id',
  'thread_id',
  'active_tools',
  'args_bytes',
  'args_truncated',
  'resp_bytes',
  'resp_truncated',
  'policy',
  'by',
  'used',
  'limit',
  'remaining',
  'attempt',
  'max',
  'via',
] as const;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeText(value: unknown, limit: number): string {
  return redactText(String(value ?? '')).slice(0, limit);
}

function safeUsage(value: Record<string, unknown> | null): Record<string, number> | null {
  if (!value) return null;
  const out: Record<string, number> = {};
  for (const key of SAFE_USAGE_KEYS) {
    const n = Number(value[key]);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return Object.keys(out).length ? out : null;
}

function safeScalar(value: unknown): unknown {
  if (typeof value === 'string') return safeText(value, 512);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function argumentKeys(value: unknown): string[] {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown; }
    catch { return []; }
  }
  const keys = Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : parsed && typeof parsed === 'object'
      ? Object.keys(parsed as Record<string, unknown>)
      : [];
  return [...new Set(keys.map((key) => safeText(key, 128)).filter(Boolean))].slice(0, 50);
}

/**
 * 会话页是日常审计视图，不复用完整 Job Trace 的 raw detail。
 * 即使 Tool Provider 开了 log_payload，这里也只显示键名、字节数和治理结果；完整载荷仍留在授权的单 Job 审计页。
 */
export function safeAgentClientAuditDetail(event: string, value: unknown): Record<string, unknown> {
  const detail = objectValue(value);
  const out: Record<string, unknown> = {};
  for (const key of SAFE_AUDIT_KEYS) {
    const kept = safeScalar(detail[key]);
    if (kept !== undefined) out[key] = kept;
  }
  if (event === 'tool_call') {
    const keys = argumentKeys(detail['args']);
    if (keys.length) out['argument_keys'] = keys;
  }
  return out;
}

function safeAuditEvent(
  audit: RawTraceAudit,
  source: AgentClientTraceSource,
  toolJobId?: string,
): AgentClientTraceEvent {
  const event = String(audit.event || 'unknown');
  const detail = safeAgentClientAuditDetail(event, audit.detail);
  const rebuiltSummary = traceSummaryOf(event, detail);
  // Agent Client 早期记录在新增专属 stage/title 前已可能落库，查询时只对这组已知事件补齐语义。
  // 其他审计事件仍以写入时固化的 stage/title 为事实，避免查询层重新解释历史。
  const remapAgentEvent = event.startsWith('agent_client_') || event.startsWith('agent_tool_');
  return {
    ts: new Date(audit.ts).toISOString(),
    event,
    stage: remapAgentEvent ? traceStageOf(event, detail) : audit.stage,
    severity: remapAgentEvent ? traceSeverityOf(event, detail) : audit.severity,
    // title 同样由事件名重建，不投影可由写入方自定义的文本。
    title: safeText(traceTitleOf(event), 128),
    // 不回落到 raw audit.summary：审批 confirmPrompt 等历史摘要可能已替换过真实参数值。
    summary: safeText(rebuiltSummary, 512),
    detail,
    source,
    ...(toolJobId ? { tool_job_id: toolJobId } : {}),
  };
}

function elapsedMs(start: string, end: string | null): number | undefined {
  if (!end) return undefined;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : undefined;
}

function latestApproval(approvals: ToolApproval[]): ToolApproval | undefined {
  return approvals.length ? approvals[approvals.length - 1] : undefined;
}

export function buildAgentClientTrace(input: {
  run: AgentClientTraceRun;
  runAudit: RawTraceAudit[];
  tools: AgentClientTraceToolInput[];
  candidatesTruncated?: boolean;
}): Record<string, unknown> {
  const runUsage = safeUsage(input.run.usage);
  const approvalCount = input.tools.reduce((count, tool) => count + tool.approvals.length, 0);
  const events: Array<AgentClientTraceEvent & { order: number }> = [];
  let order = 0;
  events.push({
    ts: new Date(input.run.created_at).toISOString(),
    event: 'agent_client_run_started',
    stage: 'launch',
    severity: 'info',
    title: '本地智能体开始处理',
    summary: '本轮由本地智能体负责理解、规划和工具选择',
    detail: { planner: 'local_agent', hidden_reasoning_sync: false },
    source: 'local_agent',
    order: order++,
  });

  for (const audit of input.runAudit) {
    if (audit.event === 'agent_client_run_completed') continue;
    events.push({ ...safeAuditEvent(audit, 'hub_governance'), order: order++ });
  }

  const invocations = input.tools.map(({ job, audit, approvals }) => {
    for (const entry of audit) {
      events.push({ ...safeAuditEvent(entry, 'hub_governance', job.job_id), order: order++ });
    }
    const metadata = objectValue(job.metadata);
    const result = objectValue(job.result);
    const approval = latestApproval(approvals);
    const duration = elapsedMs(job.created_at, job.updated_at);
    return {
      job_id: job.job_id,
      invocation_id: safeText(metadata['agent_invocation_id'], 64),
      tool: safeText(metadata['agent_tool'], 64),
      status: job.status,
      state: safeText(result['state'], 64) || null,
      ok: typeof result['ok'] === 'boolean' ? result['ok'] : null,
      business_status: safeScalar(result['business_status']) ?? null,
      approval_status: approval?.status ?? null,
      approval_id: approval?.id ?? null,
      event_count: audit.length,
      ...(duration !== undefined ? { duration_ms: duration } : {}),
      created_at: new Date(job.created_at).toISOString(),
      updated_at: new Date(job.updated_at).toISOString(),
    };
  });

  if (input.run.completed_at) {
    events.push({
      ts: new Date(input.run.completed_at).toISOString(),
      event: 'agent_client_run_completed',
      stage: 'delivery',
      severity: input.run.status === 'completed' ? 'info' : input.run.status === 'failed' ? 'error' : 'warning',
      title: '本地智能体已提交最终回复',
      summary: [input.run.status, input.run.model, input.run.runtime].filter(Boolean).map((v) => safeText(v, 191)).join(' · '),
      detail: { status: input.run.status },
      source: 'local_agent',
      order: order++,
    });
  }

  events.sort((a, b) => {
    const byTime = new Date(a.ts).getTime() - new Date(b.ts).getTime();
    return byTime || a.order - b.order;
  });
  const publicEvents = events.map(({ order: _order, ...event }) => event);
  const duration = elapsedMs(input.run.created_at, input.run.completed_at ?? input.run.updated_at);

  return {
    kind: 'agent_client_run',
    run: {
      run_id: input.run.run_id,
      thread_id: input.run.thread_id,
      client_app_id: input.run.client_app_id,
      route_key: input.run.route_key,
      status: input.run.status,
      model: input.run.model,
      runtime: input.run.runtime,
      usage: runUsage,
      created_at: new Date(input.run.created_at).toISOString(),
      updated_at: new Date(input.run.updated_at).toISOString(),
      completed_at: input.run.completed_at ? new Date(input.run.completed_at).toISOString() : null,
      governance: {
        planner: 'local_agent',
        execution: 'bailinghub_governed',
        hidden_reasoning_sync: false,
        tool_payloads: 'summary_only',
      },
    },
    trace: {
      summary: {
        event_count: publicEvents.length,
        tool_invocations: invocations.length,
        approvals: approvalCount,
        warning_count: publicEvents.filter((event) => event.severity === 'warning').length,
        error_count: publicEvents.filter((event) => event.severity === 'error').length,
        ...(duration !== undefined ? { duration_ms: duration } : {}),
        partial: !!input.candidatesTruncated,
      },
      events: publicEvents,
    },
    invocations,
  };
}
