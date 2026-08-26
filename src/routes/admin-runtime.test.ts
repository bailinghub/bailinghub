import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Job, ToolApproval } from '../core/contracts/types';
import { completeTraceEntry } from '../core/runtime/trace-runtime';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { AgentClientRunRecord } from '../infrastructure/config/config-agent-client-runtime-repository';
import { AGENT_TOOL_JOB_MARKER } from '../app/agent-tool-job';
import { handleAdminRuntimeApiFor } from './admin-runtime';

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string | number | string[]> = {};
  body = Buffer.alloc(0);
  setHeader(name: string, value: string | number | string[]): void { this.headers[name.toLowerCase()] = value; }
  writeHead(code: number, headers?: Record<string, string | number | string[]>): void {
    this.statusCode = code;
    for (const [name, value] of Object.entries(headers ?? {})) this.headers[name.toLowerCase()] = value;
  }
  end(value?: string | Buffer): void { this.body = value ? Buffer.from(value) : Buffer.alloc(0); }
  json(): any { return JSON.parse(this.body.toString('utf8')); }
}

const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const VALID_JOB_ID = '223e4567-e89b-42d3-a456-426614174000';
const FORGED_JOB_ID = '323e4567-e89b-42d3-a456-426614174000';
const SESSION_ID = '423e4567-e89b-42d3-a456-426614174000';
const OTHER_RUN_ID = '523e4567-e89b-42d3-a456-426614174000';
const OTHER_RUN_JOB_ID = '623e4567-e89b-42d3-a456-426614174000';
const INVOCATION_ID = 'a'.repeat(64);

function run(): AgentClientRunRecord {
  return {
    run_id: RUN_ID,
    session_id: SESSION_ID,
    client_app_id: 'digital-cloud',
    route_key: 'tenant-agent',
    thread_id: 42,
    client_conversation_id: 'conversation-1',
    client_turn_id: 'turn-1',
    user_message_id: 'user-message-1',
    request_hash: 'PRIVATE_REQUEST_HASH',
    user_input: 'PRIVATE_USER_INPUT',
    context: { hidden_reasoning: 'PRIVATE_CONTEXT' },
    status: 'completed',
    completion_hash: 'PRIVATE_COMPLETION_HASH',
    assistant_message_id: 'assistant-message-1',
    final_content: 'PRIVATE_FINAL_CONTENT',
    model: 'deepseek-chat',
    runtime: 'deepseek-harness',
    usage: { total_tokens: 150 },
    created_at: '2026-08-26T05:46:00.000Z',
    updated_at: '2026-08-26T05:46:20.000Z',
    completed_at: '2026-08-26T05:46:20.000Z',
  };
}

function toolJob(jobId = VALID_JOB_ID): Job {
  return {
    job_id: jobId,
    request_id: `agent-tool:${'b'.repeat(64)}`,
    status: 'done',
    target: 'agent-tool-v1',
    profile: 'general',
    project: '',
    source: 'agent-tool:digital-cloud',
    client_app_id: 'digital-cloud',
    agent_session_id: SESSION_ID,
    on_behalf_of: 'tenant-2:user-7',
    thread_id: 42,
    session_id: RUN_ID,
    input_preview: 'Agent tool staff_edit',
    result: { state: 'executed', ok: true, business_status: 200, text: 'PRIVATE_JOB_RESULT' },
    metadata: {
      agent_tool_job_marker: AGENT_TOOL_JOB_MARKER,
      agent_tool_call_v1: true,
      agent_invocation_id: INVOCATION_ID,
      agent_run_id: RUN_ID,
      agent_route: 'tenant-agent',
      agent_tool: 'staff_edit',
      agent_args_hash: 'c'.repeat(64),
      agent_capability_revision: 'd'.repeat(64),
      agent_execution_fingerprint: 'e'.repeat(64),
      agent_thread_id: 42,
    },
    dispatch: { route_key: 'tenant-agent' },
    created_at: '2026-08-26T05:46:10.000Z',
    updated_at: '2026-08-26T05:46:12.000Z',
  };
}

function depsFor(agentRun = run()) {
  const valid = toolJob();
  const forged = { ...toolJob(FORGED_JOB_ID), metadata: { ...toolJob(FORGED_JOB_ID).metadata, agent_tool_job_marker: 'forged' } };
  const otherRun = {
    ...toolJob(OTHER_RUN_JOB_ID),
    session_id: OTHER_RUN_ID,
    metadata: { ...toolJob(OTHER_RUN_JOB_ID).metadata, agent_run_id: OTHER_RUN_ID },
  };
  const approval = {
    id: 8, job_id: VALID_JOB_ID, request_id: 'approval-1', provider: 'business', tool: 'staff_edit',
    scope: 'staff.write', risk: 'medium', args_hash: 'f'.repeat(64), args_json: 'PRIVATE_APPROVAL_ARGS',
    status: 'approved', created_at: '2026-08-26T05:46:10.100Z',
  } as ToolApproval;
  const configStore = {
    agentClientRuntime: { findRunForInvocation: async (id: string) => id === RUN_ID ? agentRun : null },
    observability: {
      agentToolJobCandidatesForRun: async () => ({ jobs: [forged, otherRun, valid], truncated: false }),
      auditForJob: async (id: string) => id === RUN_ID
        ? [completeTraceEntry({
          ts: '2026-08-26T05:46:01.000Z', job_id: RUN_ID, request_id: 'turn-1',
          event: 'agent_client_turn_context_ready', detail: { route: 'tenant-agent', active_tools: 4, agent_session_id: 'PRIVATE_SESSION' },
        })]
        : [completeTraceEntry({
          ts: '2026-08-26T05:46:11.000Z', job_id: id, request_id: 'invoke', event: 'tool_call',
          detail: { tool: 'staff_edit', args: '{"name":"PRIVATE_TOOL_ARGUMENT"}', idempotency_key: 'PRIVATE_KEY' },
        })],
      auditsForJobs: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, [completeTraceEntry({
        ts: '2026-08-26T05:46:11.000Z', job_id: id, request_id: 'invoke', event: 'tool_call',
        detail: { tool: 'staff_edit', args: '{"name":"PRIVATE_TOOL_ARGUMENT"}', idempotency_key: 'PRIVATE_KEY' },
      })]])),
    },
    approvals: {
      forJob: async (id: string) => id === VALID_JOB_ID ? [approval] : [],
      forJobs: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, id === VALID_JOB_ID ? [approval] : []])),
    },
  } as unknown as ConfigStoreContract;
  const stateStore = {
    getJob: async (id: string) => id === VALID_JOB_ID ? valid : id === FORGED_JOB_ID ? forged : id === OTHER_RUN_JOB_ID ? otherRun : null,
  } as unknown as RuntimeStateStore;
  return {
    configStore,
    stateStore,
    now: () => '2026-08-26T05:47:00.000Z',
    isPaused: () => false,
    queueStats: () => ({}),
    channelSend: async () => ({ ok: true as const }),
    engineRuntime: { requeueForRerun: async () => undefined },
  };
}

test('Agent Run trace 以 thread/run 归属聚合并排除伪造工具 Job', async () => {
  const res = new FakeResponse();
  const handled = await handleAdminRuntimeApiFor(
    depsFor(),
    'GET',
    `/admin/api/threads/42/agent-runs/${RUN_ID}/trace`,
    {} as IncomingMessage,
    res as unknown as ServerResponse,
    { kind: 'admin', via: 'session', username: 'viewer', role: 'viewer' },
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const payload = res.json();
  assert.equal(payload.kind, 'agent_client_run');
  assert.deepEqual(payload.invocations.map((item: any) => item.job_id), [VALID_JOB_ID]);
  assert.equal(payload.trace.summary.tool_invocations, 1);
  assert.equal(payload.trace.events.some((event: any) => event.source === 'local_agent'), true);
  assert.equal(payload.trace.events.some((event: any) => event.source === 'hub_governance'), true);

  const json = JSON.stringify(payload);
  for (const forbidden of [
    'PRIVATE_REQUEST_HASH', 'PRIVATE_USER_INPUT', 'PRIVATE_CONTEXT', 'PRIVATE_COMPLETION_HASH',
    'PRIVATE_FINAL_CONTENT', 'PRIVATE_JOB_RESULT', 'PRIVATE_APPROVAL_ARGS', 'PRIVATE_SESSION',
    'PRIVATE_TOOL_ARGUMENT', 'PRIVATE_KEY',
  ]) assert.equal(json.includes(forbidden), false, `${forbidden} must not be exposed`);
});

test('Agent Run trace 对 thread 不匹配统一返回 404', async () => {
  const res = new FakeResponse();
  await handleAdminRuntimeApiFor(
    depsFor(),
    'GET',
    `/admin/api/threads/43/agent-runs/${RUN_ID}/trace`,
    {} as IncomingMessage,
    res as unknown as ServerResponse,
    { kind: 'admin', via: 'session', username: 'viewer', role: 'viewer' },
  );
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: '智能体客户端运行不存在' });
});

test('Agent Run trace 在候选查询能力不存在时 fail closed', async () => {
  const deps = depsFor();
  delete (deps.configStore.observability as any).agentToolJobCandidatesForRun;
  const res = new FakeResponse();
  await handleAdminRuntimeApiFor(
    deps,
    'GET',
    `/admin/api/threads/42/agent-runs/${RUN_ID}/trace`,
    {} as IncomingMessage,
    res as unknown as ServerResponse,
    { kind: 'admin', via: 'session', username: 'viewer', role: 'viewer' },
  );
  assert.equal(res.statusCode, 503);
});

test('Agent Run trace 对旧扩展仓储回退到单 job 审计与审批读取', async () => {
  const deps = depsFor();
  delete (deps.configStore.observability as any).auditsForJobs;
  delete (deps.configStore.approvals as any).forJobs;
  const res = new FakeResponse();
  await handleAdminRuntimeApiFor(
    deps,
    'GET',
    `/admin/api/threads/42/agent-runs/${RUN_ID}/trace`,
    {} as IncomingMessage,
    res as unknown as ServerResponse,
    { kind: 'admin', via: 'session', username: 'viewer', role: 'viewer' },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().invocations.length, 1);
});
