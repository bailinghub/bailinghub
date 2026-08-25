import type { Job } from '../core/contracts/types';

export const AGENT_TOOL_JOB_TARGET = 'agent-tool-v1';
export const AGENT_TOOL_JOB_SOURCE_PREFIX = 'agent-tool:';
export const AGENT_TOOL_JOB_MARKER = 'bailing.agent-tool-job.v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64_RE = /^[a-f0-9]{64}$/;
const REQUEST_ID_RE = /^agent-tool:[a-f0-9]{64}$/;
const ROUTE_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const TOOL_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Agent 直调 synthetic job 的唯一判定入口。metadata 只是其中一部分；
 * target/source/client/session 均由服务端生成，普通 /run 无法仅靠伪造 metadata
 * 改变审批续执行或重跑语义。
 */
export function isAgentToolInvocationJob(job: Job | null | undefined): boolean {
  if (!job) return false;
  const metadata = job.metadata ?? {};
  const clientAppId = String(job.client_app_id ?? '');
  const agentSessionId = String(job.agent_session_id ?? '');
  const agentRunId = String(metadata['agent_run_id'] ?? '');
  return job.target === AGENT_TOOL_JOB_TARGET
    && REQUEST_ID_RE.test(job.request_id)
    && !!clientAppId
    && job.source === `${AGENT_TOOL_JOB_SOURCE_PREFIX}${clientAppId}`
    && UUID_RE.test(agentSessionId)
    && !!job.on_behalf_of
    && metadata['agent_tool_job_marker'] === AGENT_TOOL_JOB_MARKER
    && metadata['agent_tool_call_v1'] === true
    && HEX_64_RE.test(String(metadata['agent_invocation_id'] ?? ''))
    && UUID_RE.test(agentRunId)
    && job.session_id === agentRunId
    && ROUTE_RE.test(String(metadata['agent_route'] ?? ''))
    && job.dispatch?.route_key === metadata['agent_route']
    && TOOL_RE.test(String(metadata['agent_tool'] ?? ''))
    && HEX_64_RE.test(String(metadata['agent_args_hash'] ?? ''))
    && HEX_64_RE.test(String(metadata['agent_capability_revision'] ?? ''))
    && HEX_64_RE.test(String(metadata['agent_execution_fingerprint'] ?? ''));
}
