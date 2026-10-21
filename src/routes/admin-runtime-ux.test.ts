import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from '../core/contracts/types';
import { consoleExecution, approvalContinuationView } from './admin-runtime-ux';
import { approvalFeedback, approvalProgress, canOfferRerun, rerunHint } from '../../web-admin/src/runtime-feedback';

function job(overrides: Partial<Job> = {}): Job {
  return { job_id: 'synthetic-job', request_id: 'synthetic-request', status: 'done', profile: 'general',
    project: '', source: 'synthetic', input_preview: '', metadata: {},
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...overrides };
}

test('console rerun presentation rejects in-flight and uncertain outcomes without mutating records', () => {
  for (const status of ['queued', 'running', 'dispatched'] as const) {
    const snapshot = job({ status });
    assert.deepEqual(consoleExecution(snapshot), { kind: 'hub_task', rerun: { available: false, reason: 'in_flight' } });
    assert.equal(snapshot.status, status);
  }
  for (const overrides of [
    { result: { governance_state: 'reconciliation_required', auto_retry_allowed: false } },
    { result: { state: 'reconciliation_required' } },
    { error: 'tool_execution_reconciliation_required' },
  ]) {
    const snapshot = job(overrides), before = JSON.stringify(snapshot);
    const execution = consoleExecution(snapshot);
    assert.equal(execution.rerun.reason, 'outcome_unknown');
    assert.equal(canOfferRerun(execution), false);
    assert.match(rerunHint(execution), /不要重新执行/);
    assert.equal(JSON.stringify(snapshot), before);
  }
  assert.equal(canOfferRerun(consoleExecution(job({ status: 'error' }))), true);
});

test('old API responses and missing linked records never promise automatic execution', () => {
  assert.equal(canOfferRerun(undefined), false);
  assert.match(rerunHint(undefined), /未提供重跑边界/);
  assert.deepEqual(approvalContinuationView(null), { continuation_mode: 'unknown', continuation_pending: null, job_status: null });
  assert.doesNotMatch(approvalFeedback({ rerun: false }, 'approve'), /任务在途|自动重跑|执行成功/);
  assert.match(approvalProgress({ status: 'approved' }), /请查看原任务/);
});

test('manual approval, queued admission and recovery stay distinct from business success', () => {
  assert.match(approvalFeedback({ continuation_mode: 'manual', rerun: false }, 'approve'), /原客户端.*同一调用标识/);
  assert.match(approvalFeedback({ continuation_mode: 'rerun', rerun: true }, 'approve'), /重新入队/);
  assert.match(approvalFeedback({ continuation_mode: 'rerun', continuation_pending: true }, 'approve'), /决策已保存，续办处理中/);
  assert.match(approvalProgress({ status: 'approved', used_at: '2026-01-01', job_status: 'error' }), /批准已使用.*业务结果请查看原任务/);
  assert.match(approvalProgress({ status: 'approved', continuation_mode: 'manual', continuation_pending: false }), /等待原客户端/);
  assert.match(approvalProgress({ status: 'approved', continuation_mode: 'rerun', job_status: 'queued' }), /尚未确认执行结果/);
  assert.match(approvalProgress({ status: 'approved', continuation_mode: 'manual', continuation_pending: true }), /续办处理中/);
  assert.match(approvalProgress({ status: 'denied' }), /不会.*重新执行/);
});
