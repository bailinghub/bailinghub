interface ApprovalView {
  status?: string;
  used_at?: string | null;
  continuation_mode?: string;
  continuation_pending?: boolean | null;
  job_status?: string | null;
}

export function approvalProgress(row: ApprovalView): string {
  if (row.status === 'pending') return '等待业务侧或控制台决策';
  if (row.status === 'denied') return '不会因本次拒绝重新执行';
  if (row.used_at) return '批准已使用；业务结果请查看原任务';
  if (row.continuation_pending) return '决策已保存，续办处理中；请刷新核对';
  if (row.continuation_mode === 'manual') return '等待原客户端使用同一调用标识继续';
  if (row.continuation_mode === 'rerun' && row.job_status === 'queued') return '中枢任务已入队，尚未确认执行结果';
  if (row.continuation_mode === 'rerun' && ['running', 'dispatched'].includes(row.job_status ?? '')) return '原任务在途；执行结果请查看任务';
  return '决策已保存；续办与执行结果请查看原任务';
}

export function approvalFeedback(response: { rerun?: boolean; continuation_mode?: string; continuation_pending?: boolean }, action: 'approve' | 'deny'): string {
  if (response.continuation_pending) return '决策已保存，续办处理中。请刷新原审批单核对，不要另建请求。';
  if (action === 'deny') return '已拒绝，不会因本次拒绝重新执行。';
  if (response.continuation_mode === 'manual') return '已批准。请回原客户端使用同一调用标识继续；中枢不会自动重跑。';
  if (response.rerun) return '已批准，中枢任务已重新入队。执行结果请查看原任务。';
  return '已批准。请查看原任务确认续办进度与执行结果。';
}

export interface ConsoleExecution {
  kind: 'agent_tool' | 'hub_task';
  rerun: { available: boolean; reason: 'outcome_unknown' | 'original_client' | 'in_flight' | null };
}

export function rerunHint(execution?: ConsoleExecution): string {
  if (!execution) return '当前快照未提供重跑边界，请刷新或由管理员核对。';
  if (execution.rerun.reason === 'outcome_unknown') return '原调用结果不明，可能已产生业务变化。请先用原调用标识或幂等键到业务侧核对，不要重新执行。';
  if (execution.kind === 'agent_tool') return '这是本地智能体的工具调用。请回原客户端查看原调用；需要继续时沿用同一调用标识，中枢不提供模型重跑。';
  if (execution.rerun.reason === 'in_flight') return '原任务仍在途，请刷新查看进度，无需重新执行。';
  return '';
}

export function canOfferRerun(execution?: ConsoleExecution): boolean {
  return execution?.kind === 'hub_task' && execution.rerun?.available === true && execution.rerun.reason === null;
}
