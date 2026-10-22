import type { ToolApproval } from '../core/contracts/types';
import { truncateUtf8 } from '../core/platform/http-body';

const INLINE_ARGUMENTS_MAX_BYTES = 4096;
const INLINE_INTENT_MAX_BYTES = 8192;

/** List polling carries small historical snapshots, never repeated MiB-scale execution input. */
export function approvalListView(approval: ToolApproval): Record<string, unknown> {
  const args = approval.args_json ?? '';
  const argsBytes = Buffer.byteLength(args, 'utf8');
  const intentBytes = Buffer.byteLength(JSON.stringify(approval.intent ?? {}), 'utf8');
  const intentJsonBytes = Buffer.byteLength(approval.intent_json ?? '', 'utf8');
  const deferred = argsBytes > INLINE_ARGUMENTS_MAX_BYTES
    || intentBytes > INLINE_INTENT_MAX_BYTES || intentJsonBytes > INLINE_INTENT_MAX_BYTES;
  if (!deferred) return {
    ...approval, args_bytes: argsBytes, args_truncated: false, details_available: false,
  };
  const { args_json: _args, intent: _intent, intent_json: _intentJson, ...metadata } = approval;
  return {
    ...metadata,
    args_preview: truncateUtf8(args, INLINE_ARGUMENTS_MAX_BYTES),
    args_bytes: argsBytes,
    args_truncated: argsBytes > INLINE_ARGUMENTS_MAX_BYTES,
    details_available: true,
  };
}

/** Authorized, explicitly requested single-record view; no preview replaces the stored input. */
export function approvalDetailView(approval: ToolApproval): Record<string, unknown> {
  return {
    ...approval,
    args_bytes: Buffer.byteLength(approval.args_json ?? '', 'utf8'),
    args_truncated: false,
    details_available: false,
  };
}
