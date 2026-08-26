import assert from 'node:assert/strict';
import test from 'node:test';
import type { Job, ToolApproval } from '../contracts/types';
import { buildAgentClientTrace, safeAgentClientAuditDetail } from './agent-client-trace';
import { completeTraceEntry } from './trace-runtime';

const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const JOB_ID = '223e4567-e89b-42d3-a456-426614174000';
const INVOCATION_ID = 'a'.repeat(64);

function toolJob(): Job {
  return {
    job_id: JOB_ID,
    request_id: `agent-tool:${'b'.repeat(64)}`,
    status: 'done',
    target: 'agent-tool-v1',
    profile: 'general',
    project: '',
    source: 'agent-tool:digital-cloud',
    client_app_id: 'digital-cloud',
    agent_session_id: '323e4567-e89b-42d3-a456-426614174000',
    on_behalf_of: 'tenant-2:user-7',
    thread_id: 42,
    session_id: RUN_ID,
    input_preview: 'Agent tool staff_edit',
    result: { state: 'executed', ok: true, business_status: 200, text: 'PRIVATE_RESULT_TEXT' },
    metadata: {
      agent_invocation_id: INVOCATION_ID,
      agent_tool: 'staff_edit',
      agent_run_id: RUN_ID,
      agent_session_id: 'PRIVATE_AGENT_SESSION',
    },
    dispatch: { route_key: 'tenant-agent' },
    created_at: '2026-08-26T05:46:10.000Z',
    updated_at: '2026-08-26T05:46:12.000Z',
  };
}

function approval(): ToolApproval {
  return {
    id: 9,
    job_id: JOB_ID,
    request_id: 'approval-request',
    provider: 'business',
    tool: 'staff_edit',
    scope: 'staff.write',
    risk: 'medium',
    args_hash: 'c'.repeat(64),
    args_json: '{"name":"PRIVATE_APPROVAL_ARGS"}',
    intent_json: '{"reason":"PRIVATE_INTENT"}',
    on_behalf_of: 'PRIVATE_SUBJECT',
    status: 'approved',
    created_at: '2026-08-26T05:46:10.100Z',
    decided_at: '2026-08-26T05:46:10.500Z',
  };
}

test('Agent Client 会话轨迹只投影安全运行边界和工具治理摘要', () => {
  const result = buildAgentClientTrace({
    run: {
      run_id: RUN_ID,
      thread_id: 42,
      client_app_id: 'digital-cloud',
      route_key: 'tenant-agent',
      status: 'completed',
      model: 'deepseek-chat',
      runtime: 'deepseek-harness',
      usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150, hidden_reasoning: 'PRIVATE_REASONING' },
      created_at: '2026-08-26T05:46:00.000Z',
      updated_at: '2026-08-26T05:46:20.000Z',
      completed_at: '2026-08-26T05:46:20.000Z',
    },
    runAudit: [completeTraceEntry({
      ts: '2026-08-26T05:46:01.000Z', job_id: RUN_ID, request_id: 'turn-1',
      event: 'agent_client_turn_context_ready',
      detail: { route: 'tenant-agent', active_tools: 4, agent_session_id: 'PRIVATE_AGENT_SESSION', context: 'PRIVATE_CONTEXT' },
    })],
    tools: [{
      job: toolJob(),
      approvals: [approval()],
      audit: [
        completeTraceEntry({
          ts: '2026-08-26T05:46:10.000Z', job_id: JOB_ID, request_id: 'invoke',
          event: 'agent_tool_invocation_created',
          detail: { invocation_id: INVOCATION_ID, tool: 'staff_edit', route: 'tenant-agent', args_hash: 'PRIVATE_HASH', execution_fingerprint: 'PRIVATE_FINGERPRINT' },
        }),
        {
          ...completeTraceEntry({
            ts: '2026-08-26T05:46:10.500Z', job_id: JOB_ID, request_id: 'invoke',
            event: 'agent_tool_invocation_state',
            detail: { invocation_id: INVOCATION_ID, tool: 'staff_edit', state: 'awaiting_approval', ok: false },
          }),
          // 模拟修正严重级前已落库的历史记录。
          severity: 'error' as const,
        },
        completeTraceEntry({
          ts: '2026-08-26T05:46:11.000Z', job_id: JOB_ID, request_id: 'invoke',
          event: 'tool_call',
          detail: {
            provider: 'business', tool: 'staff_edit', scope: 'staff.write', method: 'POST', path: '/staff/edit',
            args: JSON.stringify({ id: 7, name: 'PRIVATE_ARGUMENT_VALUE' }), args_bytes: 48,
            on_behalf_of: 'PRIVATE_SUBJECT', idempotency_key: 'PRIVATE_IDEMPOTENCY_KEY',
          },
        }),
        completeTraceEntry({
          ts: '2026-08-26T05:46:12.000Z', job_id: JOB_ID, request_id: 'invoke',
          event: 'tool_result',
          detail: { tool: 'staff_edit', status: 200, ok: true, duration_ms: 1000, resp: 'PRIVATE_RESPONSE_BODY', resp_bytes: 128, idempotency_key: 'PRIVATE_IDEMPOTENCY_KEY' },
        }),
        completeTraceEntry({
          ts: '2026-08-26T05:46:12.500Z', job_id: JOB_ID, request_id: 'invoke',
          event: 'tool_approved',
          detail: {
            approval_id: 9, tool: 'staff_edit', policy: 'confirm', by: 'reviewer',
            summary: '把员工姓名改成 PRIVATE_APPROVAL_SUMMARY',
            reason: 'PRIVATE_APPROVAL_REASON', error: 'PRIVATE_APPROVAL_ERROR',
          },
        }),
      ],
    }],
  }) as any;

  assert.equal(result.kind, 'agent_client_run');
  assert.deepEqual(result.run.usage, { input_tokens: 120, output_tokens: 30, total_tokens: 150 });
  assert.equal(result.run.governance.hidden_reasoning_sync, false);
  assert.equal(result.trace.summary.tool_invocations, 1);
  assert.equal(result.trace.summary.approvals, 1);
  assert.equal(result.trace.summary.error_count, 0);
  assert.equal(result.trace.events.find((event: any) => event.event === 'agent_tool_invocation_state').severity, 'warning');
  assert.equal(result.invocations[0].tool, 'staff_edit');
  assert.equal(result.invocations[0].approval_status, 'approved');

  const call = result.trace.events.find((event: any) => event.event === 'tool_call');
  assert.deepEqual(call.detail.argument_keys, ['id', 'name']);
  assert.equal(call.source, 'hub_governance');
  const json = JSON.stringify(result);
  for (const forbidden of [
    'PRIVATE_REASONING', 'PRIVATE_AGENT_SESSION', 'PRIVATE_CONTEXT', 'PRIVATE_ARGUMENT_VALUE',
    'PRIVATE_SUBJECT', 'PRIVATE_IDEMPOTENCY_KEY', 'PRIVATE_RESPONSE_BODY', 'PRIVATE_APPROVAL_ARGS',
    'PRIVATE_INTENT', 'PRIVATE_HASH', 'PRIVATE_FINGERPRINT', 'PRIVATE_RESULT_TEXT',
    'PRIVATE_APPROVAL_SUMMARY', 'PRIVATE_APPROVAL_REASON', 'PRIVATE_APPROVAL_ERROR',
  ]) assert.equal(json.includes(forbidden), false, `${forbidden} must not be exposed`);
});

test('Agent Client 工具调用参数只展示键名，不展示值', () => {
  assert.deepEqual(safeAgentClientAuditDetail('tool_call', {
    tool: 'staff_edit',
    args: '["id","name"]',
    idempotency_key: 'hidden',
    summary: 'hidden summary',
    reason: 'hidden reason',
    error: 'hidden error',
  }), { tool: 'staff_edit', argument_keys: ['id', 'name'] });
});
