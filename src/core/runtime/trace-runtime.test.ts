// 覆盖：trace 解释层。audit 是事实账本，本模块负责把散装事件稳定映射为阶段、级别、摘要和统计。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJobTrace, completeTraceEntry, normalizeTraceEvent, traceSeverityOf, traceStageOf, traceSummaryOf } from './trace-runtime';
import type { Job } from '../contracts/types';

function job(extra: Partial<Job> = {}): Job {
  return {
    job_id: 'job-trace',
    request_id: 'req-trace',
    status: 'done',
    target: 'llm',
    profile: 'default',
    project: '',
    source: 'chat',
    input_preview: '问题',
    metadata: {},
    usage: { duration_ms: 1234 },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:02.000Z',
    ...extra,
  };
}

test('traceStageOf: 常见任务事件归入稳定阶段', () => {
  assert.equal(traceStageOf('received'), 'launch');
  assert.equal(traceStageOf('kb_injected'), 'context');
  assert.equal(traceStageOf('tools_retrieval_diagnostics'), 'context');
  assert.equal(traceStageOf('llm_request'), 'execution');
  assert.equal(traceStageOf('llm_stream_completed'), 'execution');
  assert.equal(traceStageOf('llm_stream_fallback'), 'execution');
  assert.equal(traceStageOf('llm_output_protocol_violation'), 'execution');
  assert.equal(traceStageOf('llm_output_protocol_repaired'), 'execution');
  assert.equal(traceStageOf('tool_budget_near_limit'), 'tool');
  assert.equal(traceStageOf('tool_budget_exhausted'), 'tool');
  assert.equal(traceStageOf('tool_result'), 'tool');
  assert.equal(traceStageOf('tool_approval_pending'), 'approval');
  assert.equal(traceStageOf('tool_approved'), 'approval');
  assert.equal(traceStageOf('delivery_webhook'), 'delivery');
  assert.equal(traceStageOf('memory_summarized'), 'summary');
  assert.equal(traceStageOf('retry_scheduled'), 'recovery');
  assert.equal(traceStageOf('ledger_error', { stage: 'delivery_channel' }), 'delivery');
  assert.equal(traceStageOf('ledger_error', { stage: 'assemble' }), 'context');
});

test('trace severity: 流式完成是信息，明确降级是警告', () => {
  assert.equal(traceSeverityOf('llm_stream_completed'), 'info');
  assert.equal(traceSeverityOf('llm_stream_fallback'), 'warning');
  assert.equal(traceSeverityOf('llm_output_protocol_violation'), 'warning');
  assert.equal(traceSeverityOf('llm_output_protocol_repaired'), 'info');
  assert.equal(traceSeverityOf('tool_budget_near_limit'), 'info');
  assert.equal(traceSeverityOf('tool_budget_exhausted'), 'warning');
  assert.equal(traceSeverityOf('tools_retrieval_diagnostics', { status: 'ok' }), 'info');
  assert.equal(traceSeverityOf('tools_retrieval_diagnostics', { status: 'degraded' }), 'warning');
});

test('工具检索诊断展示缓存状态、分阶段耗时与稳定降级原因', () => {
  const entry = completeTraceEntry({
    ts: '2026-07-01T00:00:00.000Z',
    job_id: 'job-trace',
    request_id: 'req-trace',
    event: 'tools_retrieval_diagnostics',
    detail: {
      provider: 'mall',
      status: 'degraded',
      reason: 'embedding_timeout',
      cache_state: 'fresh',
      index_load_ms: 1,
      embedding_ms: 15001,
      total_ms: 15004,
    },
  });

  assert.equal(entry.stage, 'context');
  assert.equal(entry.severity, 'warning');
  assert.equal(entry.title, '工具检索诊断');
  assert.equal(entry.summary, 'mall · degraded · embedding_timeout · cache=fresh · index 1ms · embedding 15001ms · total 15004ms');
});

test('工具预算与内部协议事件生成可读追踪', () => {
  const budget = completeTraceEntry({
    ts: '2026-07-01T00:00:00.000Z',
    job_id: 'job-trace',
    request_id: 'req-trace',
    event: 'tool_budget_exhausted',
    detail: { used: 5, limit: 5, remaining: 0 },
  });
  const violation = completeTraceEntry({
    ts: '2026-07-01T00:00:01.000Z',
    job_id: 'job-trace',
    request_id: 'req-trace',
    event: 'llm_output_protocol_violation',
    detail: { model: 'deepseek', round: 6, marker: 'dsml_tool_markup', tool_calls_used: 5, tool_calls_limit: 5 },
  });

  assert.equal(budget.stage, 'tool');
  assert.equal(budget.severity, 'warning');
  assert.equal(budget.title, '工具调用已达上限');
  assert.equal(budget.summary, '5/5 calls · 0 remaining');
  assert.equal(violation.stage, 'execution');
  assert.equal(violation.severity, 'warning');
  assert.equal(violation.title, '模型内部协议已拦截');
  assert.equal(violation.summary, 'deepseek · round 6 · dsml_tool_markup · 5/5 calls');
});

test('llm_stream_completed 摘要直接展示首 token、总耗时与请求规模', () => {
  const entry = completeTraceEntry({
    ts: '2026-07-01T00:00:00.000Z',
    job_id: 'job-trace',
    request_id: 'req-trace',
    event: 'llm_stream_completed',
    detail: {
      model: 'kimi-k3',
      round: 2,
      chunks: 150,
      content_chars: 22,
      reasoning_chars: 640,
      first_token_ms: 10452,
      duration_ms: 14003,
      request_chars: 12890,
      finish_reason: 'tool_calls',
    },
  });

  assert.equal(
    entry.summary,
    'kimi-k3 · round 2 · 150 chunks · 22 chars · 640 reasoning chars · first token 10452ms · total 14003ms · request 12890 chars · tool_calls',
  );
});

test('traceSeverityOf: 错误、降级、跳过和正常事件分级', () => {
  assert.equal(traceSeverityOf('finished', { status: 'error' }), 'error');
  assert.equal(traceSeverityOf('channel_delivery_error'), 'error');
  assert.equal(traceSeverityOf('perception_degraded'), 'warning');
  assert.equal(traceSeverityOf('delivery_skipped'), 'warning');
  assert.equal(traceSeverityOf('retry_scheduled'), 'warning');
  assert.equal(traceSeverityOf('tool_result', { ok: true, status: 200 }), 'info');
  assert.equal(traceSeverityOf('agent_tool_invocation_state', { state: 'in_progress', ok: false }), 'info');
  assert.equal(traceSeverityOf('agent_tool_invocation_state', { state: 'awaiting_approval', ok: false }), 'warning');
  assert.equal(traceSeverityOf('agent_tool_invocation_state', { state: 'reconciliation_required', ok: false }), 'error');
});

test('Agent Client 生命周期与直调工具事件使用明确的展示阶段和标题', () => {
  assert.equal(traceStageOf('agent_client_run_started'), 'launch');
  assert.equal(traceStageOf('agent_client_turn_context_ready'), 'context');
  assert.equal(traceStageOf('agent_tool_invocation_created'), 'tool');
  assert.equal(traceStageOf('agent_client_run_completed'), 'delivery');
  assert.equal(completeTraceEntry({
    ts: '2026-08-26T00:00:00.000Z', job_id: 'run', request_id: 'turn',
    event: 'agent_client_turn_context_ready', detail: { route: 'tenant-agent', active_tools: 3 },
  }).title, '运行上下文已就绪');
  assert.equal(traceSummaryOf('agent_tool_invocation_state', {
    tool: 'staff_edit', state: 'executed', business_status: 200,
  }), 'staff_edit · executed · business=200');
});

test('completeTraceEntry + normalizeTraceEvent: 写入时固化结构化 trace 字段并保留对象 detail', () => {
  const entry = completeTraceEntry({
    ts: '2026-07-01T00:00:00.000Z',
    job_id: 'job-trace',
    request_id: 'req-trace',
    event: 'tool_result',
    detail: { tool: 'order.get', status: 200, duration_ms: 38 },
  });
  const got = normalizeTraceEvent(entry);

  assert.equal(entry.stage, 'tool');
  assert.equal(entry.severity, 'info');
  assert.equal(entry.title, '工具结果');
  assert.equal(entry.summary, 'order.get · HTTP 200 · 38ms');
  assert.equal(got.stage, 'tool');
  assert.equal(got.severity, 'info');
  assert.equal(got.title, '工具结果');
  assert.equal(got.summary, 'order.get · HTTP 200 · 38ms');
  assert.deepEqual(got.detail, { tool: 'order.get', status: 200, duration_ms: 38 });
});

test('completeTraceEntry: 视觉感知失败摘要带出模型错误原因', () => {
  const entry = completeTraceEntry({
    ts: '2026-07-01T00:00:00.000Z',
    job_id: 'job-trace',
    request_id: 'req-trace',
    event: 'perception',
    detail: {
      mode: 'prepass',
      model: 'qwen2.5-vl-72b-instruct',
      images: 1,
      ok: false,
      error: '视觉模型调用失败（HTTP 403）：access_denied',
    },
  });

  assert.equal(entry.severity, 'error');
  assert.equal(entry.summary, 'prepass · qwen2.5-vl-72b-instruct · 1 images · failed · 视觉模型调用失败（HTTP 403）：access_denied');
});

test('normalizeTraceEvent: 字符串 detail 不再解析 JSON，非对象统一归空对象', () => {
  const completed = completeTraceEntry({
    ts: '2026-07-01T00:00:00.000Z',
    job_id: 'job-trace',
    request_id: 'req-trace',
    event: 'tool_result',
    detail: '{"tool":"order.get","status":200}' as any,
  });
  const normalized = normalizeTraceEvent({
    ts: '2026-07-01T00:00:01.000Z',
    event: 'tool_result',
    stage: 'tool',
    severity: 'info',
    title: '工具结果',
    summary: 'done',
    detail: '{"tool":"order.get","status":200}',
  });

  assert.deepEqual(completed.detail, {});
  assert.deepEqual(normalized.detail, {});
  assert.deepEqual(normalizeTraceEvent({ ...normalized, detail: ['not-object'] }).detail, {});
});

test('buildJobTrace: 汇总阶段、错误、工具、模型、知识和消息统计', () => {
  const trace = buildJobTrace({
    job: job(),
    messages: [{ direction: 'in' }, { direction: 'out' }],
    audit: [
      completeTraceEntry({ ts: '2026-07-01T00:00:00.000Z', job_id: 'job-trace', request_id: 'req-trace', event: 'received', detail: { target: 'llm', profile: 'default' } }),
      completeTraceEntry({ ts: '2026-07-01T00:00:00.100Z', job_id: 'job-trace', request_id: 'req-trace', event: 'kb_injected', detail: { mode: 'chunk', hits: 2, top_score: 0.9 } }),
      completeTraceEntry({ ts: '2026-07-01T00:00:00.200Z', job_id: 'job-trace', request_id: 'req-trace', event: 'llm_request', detail: { model: 'qwen', tool_mode: 'retrieval', tools_offered: ['a'], tools_total: 3 } }),
      completeTraceEntry({ ts: '2026-07-01T00:00:00.300Z', job_id: 'job-trace', request_id: 'req-trace', event: 'tool_call', detail: { tool: 'order.get', scope: 'order.read' } }),
      completeTraceEntry({ ts: '2026-07-01T00:00:00.400Z', job_id: 'job-trace', request_id: 'req-trace', event: 'tool_result', detail: { tool: 'order.get', status: 500, ok: false } }),
      completeTraceEntry({ ts: '2026-07-01T00:00:00.500Z', job_id: 'job-trace', request_id: 'req-trace', event: 'delivery_skipped', detail: { reason: '无可投递内容' } }),
      completeTraceEntry({ ts: '2026-07-01T00:00:00.600Z', job_id: 'job-trace', request_id: 'req-trace', event: 'memory_summarized', detail: { to_id: 9, model: 'qwen' } }),
      completeTraceEntry({ ts: '2026-07-01T00:00:00.700Z', job_id: 'job-trace', request_id: 'req-trace', event: 'tool_approval_pending', detail: { approval_id: 3, tool: 'order.refund' } }),
    ],
  });

  assert.equal(trace.summary.event_count, 8);
  assert.equal(trace.summary.error_count, 1);
  assert.equal(trace.summary.warning_count, 2);
  assert.equal(trace.summary.tool_calls, 1);
  assert.equal(trace.summary.tool_results, 1);
  assert.equal(trace.summary.approvals, 1);
  assert.equal(trace.summary.llm_requests, 1);
  assert.equal(trace.summary.knowledge_events, 1);
  assert.equal(trace.summary.deliveries, 1);
  assert.equal(trace.summary.message_count, 2);
  assert.equal(trace.summary.duration_ms, 1234);
  assert.equal(trace.summary.stage_count.launch, 1);
  assert.equal(trace.summary.stage_count.context, 1);
  assert.equal(trace.summary.stage_count.tool, 2);
  assert.equal(trace.summary.stage_count.approval, 1);
});
