// Trace 运行时：把底层 audit 流规范化成可展示、可导出、可被外部系统消费的任务回放模型。
// 写入时即固化 stage/severity/title/summary；trace 查询只做聚合，不再让前端按 event/detail 猜。
// 本模块不读写数据库，不依赖 runtime 单例。
import type { AuditEntry, Job, TraceSeverity, TraceStage } from '../contracts/types';

export interface RawTraceAudit {
  ts: string;
  event: string;
  stage: TraceStage;
  severity: TraceSeverity;
  title: string;
  summary: string;
  detail: unknown;
}

export interface TraceEvent {
  ts: string;
  event: string;
  stage: TraceStage;
  severity: TraceSeverity;
  title: string;
  summary: string;
  detail: Record<string, unknown>;
}

export interface JobTraceSummary {
  job_id: string;
  request_id: string;
  status: Job['status'];
  stage_count: Record<TraceStage, number>;
  event_count: number;
  error_count: number;
  warning_count: number;
  tool_calls: number;
  tool_results: number;
  approvals: number;
  deliveries: number;
  llm_requests: number;
  perceptions: number;
  knowledge_events: number;
  message_count: number;
  duration_ms?: number;
}

export interface JobTrace {
  summary: JobTraceSummary;
  events: TraceEvent[];
}

export function buildJobTrace(input: {
  job: Job;
  audit: RawTraceAudit[];
  approvals?: unknown[];
  messages?: unknown[];
}): JobTrace {
  const events = input.audit.map(normalizeTraceEvent);
  return {
    summary: buildTraceSummary(input.job, events, input.messages ?? []),
    events,
  };
}

export function normalizeTraceEvent(a: RawTraceAudit): TraceEvent {
  const detail = objectDetail(a.detail);
  const event = String(a.event || 'unknown');
  return {
    ts: new Date(a.ts).toISOString(),
    event,
    stage: a.stage,
    severity: a.severity,
    title: a.title,
    summary: a.summary,
    detail,
  };
}

export function completeTraceEntry(entry: AuditEntry): Required<AuditEntry> {
  const detail = objectDetail(entry.detail);
  const event = String(entry.event || 'unknown');
  const stage = (entry.stage as TraceStage | undefined) ?? traceStageOf(event, detail);
  const severity = entry.severity ?? traceSeverityOf(event, detail);
  const title = entry.title ?? traceTitleOf(event);
  const summary = entry.summary ?? traceSummaryOf(event, detail);
  return {
    ...entry,
    event,
    stage,
    severity,
    title: title.slice(0, 128),
    summary: summary.slice(0, 512),
    detail,
  };
}

export function traceStageOf(event: string, detail: Record<string, unknown> = {}): TraceStage {
  if (event === 'received' || event === 'awaiting_executor' || event === 'rejected') return 'launch';
  if (
    event === 'kb_injected' || event === 'kb_error' ||
    event === 'perception_degraded' || event === 'speech_degraded' || event === 'file_input' || event === 'file_input_degraded' ||
    event === 'tools_retrieval_degraded'
  ) return 'context';
  if (event.startsWith('memory_summary') || event === 'memory_summarized') return 'summary';
  if (event === 'recovered' || event === 'rerun' || event === 'retry_scheduled') return 'recovery';
  if (event.includes('approval') || event === 'tool_approved' || event === 'tool_denied' || event === 'tool_args_drift') return 'approval';
  if (event.startsWith('tool_') || event === 'tools_retrieved' || event === 'tool_lookup' || event === 'builtin_send' || event.startsWith('builtin_send_')) return 'tool';
  if (event.startsWith('delivery') || event.startsWith('channel_delivery') || event.startsWith('dlq_')) return 'delivery';
  if (event.startsWith('channel_') || event.startsWith('wecom_') || event === 'chat_upload' || event === 'chat_upload_error' || event === 'chat_rated') return 'channel';
  if (
    event === 'started' || event === 'dispatched' || event === 'finished' ||
    event === 'llm_request' || event === 'llm_stream_completed' || event === 'llm_stream_fallback' ||
    event === 'llm_empty_response_retry' || event === 'llm_empty_response_fallback' ||
    event === 'perception' || event === 'tools_unavailable' || event === 'tools_locked'
  ) return 'execution';
  if (event === 'config_change' || event.endsWith('_revealed') || event.startsWith('kb_doc_') || event.startsWith('kb_ds_') || event.startsWith('tool_index_') || event === 'authorize_probe') return 'config';
  if (event === 'ledger_error') {
    const stage = String(detail['stage'] ?? '');
    if (stage.includes('delivery')) return 'delivery';
    if (stage === 'resolve' || stage === 'assemble') return 'context';
  }
  if (event === 'alert' || event.startsWith('alert_')) return 'system';
  return 'system';
}

export function traceSeverityOf(event: string, detail: Record<string, unknown> = {}): TraceSeverity {
  const status = String(detail['status'] ?? '');
  if (event === 'finished' && (status === 'error' || status === 'rejected')) return 'error';
  if (event.includes('error') || event.includes('failed') || event.endsWith('_failure')) return 'error';
  if (detail['ok'] === false || detail['final'] === true && detail['ok'] === false) return 'error';
  if (event === 'rejected' || event.includes('degraded') || event.includes('unavailable') || event.includes('locked') || event.includes('blocked')) return 'warning';
  if (event.includes('skipped') || event === 'retry_scheduled' || event === 'llm_stream_fallback' || event === 'llm_empty_response_retry' || event === 'llm_empty_response_fallback' || event === 'memory_summary_raced' || event === 'tool_approval_pending' || event === 'tool_args_drift') return 'warning';
  return 'info';
}

export function traceTitleOf(event: string): string {
  const titles: Record<string, string> = {
    received: '任务已接收',
    awaiting_executor: '等待执行器认领',
    rejected: '任务被拒绝',
    started: '本地执行开始',
    dispatched: '任务已派发',
    retry_scheduled: '已安排重试',
    finished: '任务已收尾',
    recovered: '任务已恢复',
    rerun: '任务已重跑',
    kb_injected: '已注入知识',
    kb_error: '知识检索失败',
    ledger_error: '总账降级',
    llm_request: '模型请求',
    llm_stream_completed: '模型流式输出完成',
    llm_stream_fallback: '模型流式输出降级',
    llm_empty_response_retry: '模型空响应修复',
    llm_empty_response_fallback: '模型空响应兜底',
    perception: '视觉感知',
    perception_degraded: '视觉感知降级',
    speech: '语音转写',
    speech_degraded: '语音输入降级',
    file_input: '文件输入处理',
    file_input_degraded: '文件输入降级',
    tools_unavailable: '工具不可用',
    tools_locked: '工具已锁定',
    tools_retrieved: '工具语义召回',
    tool_lookup: '工具定义查询',
    tool_call: '工具调用',
    tool_result: '工具结果',
    tool_call_deduped: '工具调用去重',
    tool_blocked: '工具调用被拦截',
    tool_approval_pending: '工具等待审批',
    tool_approved: '工具审批通过',
    tool_denied: '工具审批拒绝',
    tool_args_drift: '审批参数漂移',
    builtin_send: '内置发送',
    builtin_send_deduped: '内置发送去重',
    builtin_send_error: '内置发送失败',
    delivery_queued: '送达已排队',
    delivery_skipped: '送达已跳过',
    delivery_error: '送达派生失败',
    delivery_webhook: 'Webhook 送达',
    channel_delivered: '渠道送达成功',
    channel_delivery_error: '渠道送达失败',
    channel_delivery_skipped: '渠道送达跳过',
    memory_summarized: '会话已摘要',
    memory_summary_skipped: '摘要已跳过',
    memory_summary_raced: '摘要并发竞争',
    memory_summary_error: '摘要失败',
  };
  return titles[event] ?? event.replace(/_/g, ' ');
}

export function traceSummaryOf(event: string, detail: Record<string, unknown> = {}): string {
  if (event === 'received') return compact([detail['target'], detail['profile'], detail['source']]);
  if (event === 'awaiting_executor') return compact([detail['target']]);
  if (event === 'rejected') return compact([detail['reason'], detail['quota'] != null ? `quota=${detail['quota']}` : '']);
  if (event === 'dispatched') return compact([detail['executor_id'], detail['target'], detail['tools'] != null ? `${detail['tools']} tools` : '']);
  if (event === 'retry_scheduled') return compact([`attempt ${detail['attempt']}/${detail['max']}`, detail['backoff_ms'] != null ? `${detail['backoff_ms']}ms` : '', detail['via']]);
  if (event === 'finished') return compact([detail['status'], detail['cost_usd'] != null ? `$${detail['cost_usd']}` : '']);
  if (event === 'kb_injected') return compact([detail['mode'], `${detail['hits'] ?? detail['docs'] ?? 0} refs`, detail['top_score'] != null ? `score=${detail['top_score']}` : '']);
  if (event === 'llm_request') return compact([detail['model'], detail['tool_mode'], Array.isArray(detail['tools_offered']) ? `${detail['tools_offered'].length}/${detail['tools_total'] ?? '?'} tools` : '']);
  if (event === 'llm_stream_completed') return compact([
    detail['model'],
    detail['round'] != null ? `round ${detail['round']}` : '',
    detail['chunks'] != null ? `${detail['chunks']} chunks` : '',
    detail['content_chars'] != null ? `${detail['content_chars']} chars` : '',
    detail['first_token_ms'] != null ? `first token ${detail['first_token_ms']}ms` : '',
    detail['finish_reason'],
  ]);
  if (event === 'llm_stream_fallback') return compact([detail['model'], detail['round'] != null ? `round ${detail['round']}` : '', detail['status'] != null ? `HTTP ${detail['status']}` : '', detail['reason']]);
  if (event === 'llm_empty_response_retry') return compact([detail['model'], detail['tool_calls'] != null ? `${detail['tool_calls']} tool calls` : '', detail['last_tool']]);
  if (event === 'llm_empty_response_fallback') return compact([detail['model'], detail['last_tool'], detail['fallback']]);
  if (event === 'perception') return compact([
    detail['mode'],
    detail['model'],
    detail['images'] != null ? `${detail['images']} images` : '',
    detail['ok'] === false ? 'failed' : 'ok',
    detail['ok'] === false && detail['error'] ? String(detail['error']).slice(0, 120) : '',
  ]);
  if (event === 'speech') return compact([
    detail['mode'],
    detail['model'],
    detail['index'] != null ? `#${detail['index']}` : '',
    detail['ok'] === false ? 'failed' : 'ok',
    detail['ok'] === false && detail['error'] ? String(detail['error']).slice(0, 120) : '',
  ]);
  if (event === 'file_input') return compact([
    detail['mode'],
    detail['parser'],
    detail['name'],
    detail['pages'] != null ? `${detail['pages']} pages` : '',
    detail['ok'] === false ? 'failed' : 'ok',
    detail['ok'] === false && detail['error'] ? String(detail['error']).slice(0, 120) : '',
  ]);
  if (event === 'file_input_degraded') return compact([detail['requested'], detail['reason'], detail['credential']]);
  if (event === 'tools_retrieved') return compact([detail['query'] ? `"${String(detail['query']).slice(0, 40)}"` : '', Array.isArray(detail['picked']) ? `${detail['picked'].length} tools` : '']);
  if (event === 'tool_lookup') return compact([Array.isArray(detail['found']) ? `${detail['found'].length} found` : '', Array.isArray(detail['names']) ? `${detail['names'].length} requested` : '']);
  if (event === 'tool_call') return compact([detail['tool'], detail['scope'], detail['method'], detail['path']]);
  if (event === 'tool_result') return compact([detail['tool'], detail['status'] != null ? `HTTP ${detail['status']}` : '', detail['duration_ms'] != null ? `${detail['duration_ms']}ms` : '']);
  if (event === 'tool_approval_pending' || event === 'tool_approved' || event === 'tool_denied' || event === 'tool_approved_external' || event === 'tool_denied_external') return compact([detail['approval_id'], detail['summary'] ?? detail['reason'], detail['tool'], detail['policy'], detail['by']]);
  if (event.startsWith('delivery') || event.startsWith('channel_')) return compact([detail['type'], detail['channel'], detail['to'], detail['reason'], detail['error']]);
  if (event.startsWith('memory_summary') || event === 'memory_summarized') return compact([detail['reason'], detail['to_id'] != null ? `to=${detail['to_id']}` : '', detail['model']]);
  if (detail['reason']) return String(detail['reason']);
  if (detail['error']) return String(detail['error']).slice(0, 160);
  return '';
}

function buildTraceSummary(job: Job, events: TraceEvent[], messages: unknown[]): JobTraceSummary {
  const stage_count = emptyStageCount();
  for (const e of events) stage_count[e.stage]++;
  const duration = job.usage?.duration_ms ?? elapsedMs(job.created_at, job.updated_at);
  return {
    job_id: job.job_id,
    request_id: job.request_id,
    status: job.status,
    stage_count,
    event_count: events.length,
    error_count: events.filter((e) => e.severity === 'error').length,
    warning_count: events.filter((e) => e.severity === 'warning').length,
    tool_calls: events.filter((e) => e.event === 'tool_call').length,
    tool_results: events.filter((e) => e.event === 'tool_result').length,
    approvals: events.filter((e) => e.stage === 'approval').length,
    deliveries: events.filter((e) => e.stage === 'delivery').length,
    llm_requests: events.filter((e) => e.event === 'llm_request').length,
    perceptions: events.filter((e) => e.event === 'perception').length,
    knowledge_events: events.filter((e) => e.event === 'kb_injected').length,
    message_count: messages.length,
    ...(duration !== undefined ? { duration_ms: duration } : {}),
  };
}

function emptyStageCount(): Record<TraceStage, number> {
  return {
    launch: 0,
    context: 0,
    execution: 0,
    tool: 0,
    approval: 0,
    delivery: 0,
    summary: 0,
    recovery: 0,
    channel: 0,
    config: 0,
    system: 0,
  };
}

function objectDetail(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function compact(parts: unknown[]): string {
  return parts.map((p) => String(p ?? '').trim()).filter(Boolean).join(' · ');
}

function elapsedMs(start?: string, end?: string): number | undefined {
  const a = start ? new Date(start).getTime() : NaN;
  const b = end ? new Date(end).getTime() : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return undefined;
  return b - a;
}
