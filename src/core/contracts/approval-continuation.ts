/** Trusted decision coordinates, independent of business metadata and model input. */
export interface ApprovalContinuation {
  schema_version: 'bailing.approval-continuation.v1';
  approval_id: number;
  decision_key: string;
  decision_id?: string;
  decision: 'approved' | 'denied';
  job_id: string;
  request_id: string;
  args_hash: string;
  tool: string;
  scope: string;
  by: string;
  source: 'external' | 'console';
  auth: string;
  mode: 'rerun' | 'manual';
  policy?: string;
  reason?: string;
  summary?: string;
  comment?: string;
  audit_recorded: boolean;
  completed: boolean;
}

export interface ApprovalContinuationDecisionOptions {
  decision_id?: string;
  comment?: string;
  source: 'external' | 'console';
  auth: string;
  mode: 'rerun' | 'manual';
}

export interface ApprovalRequeueInput {
  job_id: string;
  request_id: string;
  approval_id: number;
  decision_key: string;
  decision_id?: string;
  /** JSONL adapter rechecks this after seeing a terminal job under its single-writer lock. */
  isApprovedUnused?: () => Promise<boolean>;
}

export type ApprovalRequeueOutcome = 'queued' | 'already_queued' | 'in_flight' | 'consumed' | 'missing' | 'conflict';
