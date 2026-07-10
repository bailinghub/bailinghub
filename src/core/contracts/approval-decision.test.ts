import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApprovalDecision, parseApprovalDecisionEnvelope } from './approval-decision';

const ref = {
  id: 12,
  job_id: 'job-1',
  request_id: 'req-1',
  args_hash: 'hash-1',
};

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'tool_approval_decision',
    schema_version: 'bailing.approval-decision.v1',
    approval_id: 12,
    job_id: 'job-1',
    request_id: 'req-1',
    args_hash: 'hash-1',
    decision_id: 'oa:approval:9001',
    decision: 'approved',
    approver: 'user_2002',
    comment: '确认处理',
    ...overrides,
  };
}

function errorOf(overrides: Record<string, unknown>): string {
  const r = parseApprovalDecisionEnvelope(body(overrides), ref);
  assert.equal(r.ok, false);
  return r.ok ? '' : r.error;
}

test('ApprovalDecision: 标准信封解析并裁剪备注', () => {
  const r = parseApprovalDecisionEnvelope(body({ comment: 'x'.repeat(1200) }), ref);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.decision, 'approved');
  assert.equal(r.value.decision_id, 'oa:approval:9001');
  assert.equal(r.value.approver, 'user_2002');
  assert.equal(r.value.comment?.length, 1000);
});

test('ApprovalDecision: 必须复核 approval_id/job_id/request_id/args_hash', () => {
  assert.match(errorOf({ approval_id: 13 }), /approval_id/);
  assert.match(errorOf({ job_id: 'job-2' }), /job_id/);
  assert.match(errorOf({ request_id: 'req-2' }), /request_id/);
  assert.match(errorOf({ args_hash: 'hash-2' }), /args_hash/);
});

test('ApprovalDecision: decision_id 和 approver 是业务侧承接必填项', () => {
  const noDecisionId = parseApprovalDecisionEnvelope(body({ decision_id: '' }), ref);
  assert.equal(noDecisionId.ok, false);
  if (!noDecisionId.ok) assert.match(noDecisionId.error, /decision_id/);

  const noApprover = parseApprovalDecisionEnvelope(body({ approver: '' }), ref);
  assert.equal(noApprover.ok, false);
  if (!noApprover.ok) assert.match(noApprover.error, /approver/);
});

test('ApprovalDecision: 只接受 approved/denied 标准决策值', () => {
  assert.equal(normalizeApprovalDecision('approved'), 'approved');
  assert.equal(normalizeApprovalDecision('denied'), 'denied');
  assert.equal(normalizeApprovalDecision('approve'), null);
  assert.equal(normalizeApprovalDecision('reject'), null);
  assert.match(errorOf({ decision: 'rejected' }), /decision/);
});
