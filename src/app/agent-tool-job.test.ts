import assert from 'node:assert/strict';
import test from 'node:test';
import type { Job } from '../core/contracts/types';
import { AGENT_TOOL_JOB_MARKER, isAgentToolInvocationJob } from './agent-tool-job';

function directJob(): Job {
  const route = 'tenant-agent';
  const runId = '22222222-2222-4222-8222-222222222222';
  return {
    job_id: '11111111-1111-4111-8111-111111111111',
    request_id: `agent-tool:${'a'.repeat(64)}`,
    status: 'done',
    target: 'agent-tool-v1',
    profile: 'general',
    project: '',
    source: 'agent-tool:example-business',
    client_app_id: 'example-business',
    agent_session_id: '33333333-3333-4333-8333-333333333333',
    on_behalf_of: 'tenant-1:user-7',
    session_id: runId,
    input_preview: 'Agent tool staff_edit',
    dispatch: { route_key: route, route_name: '门店助手', tools: {} },
    metadata: {
      agent_tool_job_marker: AGENT_TOOL_JOB_MARKER,
      agent_tool_call_v1: true,
      agent_invocation_id: 'b'.repeat(64),
      agent_run_id: runId,
      agent_route: route,
      agent_tool: 'staff_edit',
      agent_args_hash: 'c'.repeat(64),
      agent_capability_revision: 'd'.repeat(64),
      agent_execution_fingerprint: 'e'.repeat(64),
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

test('Agent direct synthetic job: 必须同时命中服务端 target/source/session 与完整指纹', () => {
  assert.equal(isAgentToolInvocationJob(directJob()), true);

  const spoofedRun = directJob();
  spoofedRun.target = 'llm';
  spoofedRun.source = 'agent:example-business';
  assert.equal(isAgentToolInvocationJob(spoofedRun), false, '/run metadata 不能单独伪造 direct job');

  const wrongRequest = directJob();
  wrongRequest.request_id = 'ordinary-run-request';
  assert.equal(isAgentToolInvocationJob(wrongRequest), false);

  const missingFingerprint = directJob();
  delete missingFingerprint.metadata!['agent_execution_fingerprint'];
  assert.equal(isAgentToolInvocationJob(missingFingerprint), false);

  const mismatchedRun = directJob();
  mismatchedRun.session_id = '44444444-4444-4444-8444-444444444444';
  assert.equal(isAgentToolInvocationJob(mismatchedRun), false);

  const mismatchedRoute = directJob();
  mismatchedRoute.dispatch!.route_key = 'other-route';
  assert.equal(isAgentToolInvocationJob(mismatchedRoute), false);
});
