// 覆盖：trace 解释层。audit 是事实账本，本模块负责把散装事件稳定映射为阶段、级别、摘要和统计。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJobTrace, completeTraceEntry, normalizeTraceEvent, traceSeverityOf, traceStageOf } from './trace-runtime';
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
  assert.equal(traceStageOf('llm_request'), 'execution');
  assert.equal(traceStageOf('llm_stream_completed'), 'execution');
  assert.equal(traceStageOf('llm_stream_fallback'), 'execution');
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
});

test('traceSeverityOf: 错误、降级、跳过和正常事件分级', () => {
  assert.equal(traceSeverityOf('finished', { status: 'error' }), 'error');
  assert.equal(traceSeverityOf('channel_delivery_error'), 'error');
  assert.equal(traceSeverityOf('perception_degraded'), 'warning');
  assert.equal(traceSeverityOf('delivery_skipped'), 'warning');
  assert.equal(traceSeverityOf('retry_scheduled'), 'warning');
  assert.equal(traceSeverityOf('tool_result', { ok: true, status: 200 }), 'info');
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
