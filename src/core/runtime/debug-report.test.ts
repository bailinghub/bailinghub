import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDebugReport } from './debug-report';

test('renderDebugReport: 基于脱敏排障包生成可读 Markdown', () => {
  const got = renderDebugReport({
    generated_at: '2026-07-02T00:00:00.000Z',
    redaction: { applied: true, rules: ['secret_like', 'email'] },
    identifiers: { job_id: 'job-1', request_id: 'req-1', route_key: 'demo' },
    dispatch: { status: 'error', target: 'demo-agent', lease_until: '2026-07-02T00:01:00.000Z' },
    outcome: { status: 'error', error: 'boom', result_preview: '失败内容' },
    counts: { audit_events: 3, trace_errors: 1, trace_warnings: 0, approvals: 0, delivery_dlq: 0, messages: 2 },
    diagnosis: [{ severity: 'error', code: 'job_error', title: '任务执行失败', detail: 'boom', next_action: '查看 trace' }],
  });
  assert.ok(got.includes('# 百灵中枢排障报告'));
  assert.ok(got.includes('脱敏状态：已脱敏'));
  assert.ok(got.includes('job_id：job-1'));
  assert.ok(got.includes('[错误] 任务执行失败'));
  assert.ok(got.includes('```text'));
});
