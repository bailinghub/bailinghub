export type ApprovalDecisionStatus = 'approved' | 'denied';

export interface ApprovalDecisionRef {
  id: number;
  job_id: string;
  request_id: string;
  args_hash: string;
}

export interface ApprovalDecisionEnvelope {
  kind: 'tool_approval_decision';
  schema_version: 'bailing.approval-decision.v1';
  approval_id: number;
  job_id: string;
  request_id: string;
  args_hash: string;
  decision: ApprovalDecisionStatus;
  decision_id: string;
  approver: string;
  comment?: string;
  decided_at?: string;
}

export type ApprovalDecisionParseResult =
  | { ok: true; value: ApprovalDecisionEnvelope }
  | { ok: false; error: string };

function field(v: unknown): string {
  return String(v ?? '').trim();
}

export function normalizeApprovalDecision(v: unknown): ApprovalDecisionStatus | null {
  const s = field(v).toLowerCase();
  if (s === 'approved') return 'approved';
  if (s === 'denied') return 'denied';
  return null;
}

function machineId(v: unknown): string {
  const s = field(v);
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(s) ? s : '';
}

export function parseApprovalDecisionEnvelope(body: Record<string, unknown>, ref: ApprovalDecisionRef): ApprovalDecisionParseResult {
  if (field(body['kind']) !== 'tool_approval_decision') {
    return { ok: false, error: 'kind 必须是 tool_approval_decision' };
  }
  if (field(body['schema_version']) !== 'bailing.approval-decision.v1') {
    return { ok: false, error: 'schema_version 必须是 bailing.approval-decision.v1' };
  }

  const approvalId = Number(body['approval_id']);
  if (!Number.isInteger(approvalId) || approvalId !== ref.id) {
    return { ok: false, error: 'approval_id 与 URL 中的审批单不一致' };
  }
  if (field(body['job_id']) !== ref.job_id) {
    return { ok: false, error: 'job_id 与审批单不一致' };
  }
  if (field(body['request_id']) !== ref.request_id) {
    return { ok: false, error: 'request_id 与审批单不一致' };
  }
  if (field(body['args_hash']) !== ref.args_hash) {
    return { ok: false, error: 'args_hash 与审批单不一致' };
  }

  const decision = normalizeApprovalDecision(body['decision']);
  if (!decision) return { ok: false, error: 'decision 必须是 approved/denied' };

  const decisionId = machineId(body['decision_id']);
  if (!decisionId) return { ok: false, error: 'decision_id 必须是 1-128 位机器可读幂等键' };

  const approver = field(body['approver'] ?? body['operator']).slice(0, 64);
  if (!approver) return { ok: false, error: 'approver 必填' };

  const comment = field(body['comment']).slice(0, 1000);
  const decidedAt = field(body['decided_at']).slice(0, 64);
  return {
    ok: true,
    value: {
      kind: 'tool_approval_decision',
      schema_version: 'bailing.approval-decision.v1',
      approval_id: approvalId,
      job_id: ref.job_id,
      request_id: ref.request_id,
      args_hash: ref.args_hash,
      decision,
      decision_id: decisionId,
      approver,
      ...(comment ? { comment } : {}),
      ...(decidedAt ? { decided_at: decidedAt } : {}),
    },
  };
}
