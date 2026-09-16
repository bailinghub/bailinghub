import type { ToolRuntimeDeps } from '../core/contracts/tools';
import type { Job } from '../core/contracts/types';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { AgentTaskControlError, taskAssert, taskDigest, taskUuid, type AgentControlledTask } from '../core/runtime/agent-task-control';
import { isAgentToolInvocationJob } from './agent-tool-job';
import { assertAgentLegacyTaskAllowedFor } from './agent-task-control';

/** Only an original runtime run can supply a task. Model arguments and arbitrary job metadata cannot enroll one. */
export async function taskRuntimeFor(config: ConfigStoreContract | null, state: RuntimeStateStore, job: Job): Promise<{
  task: AgentControlledTask | null;
  taskControl?: ToolRuntimeDeps['taskControl'];
  beforeDispatch?: () => Promise<void>;
}> {
  const hasBinding = Boolean(job.metadata.agent_task_binding || job.metadata.agent_task_id);
  if (!job.agent_session_id) { taskAssert(!hasBinding, 'TASK_BINDING_CONFLICT'); return { task: null }; }
  const repo = config?.agentTaskControl;
  if (!repo || !await repo.supportsTaskControl()) {
    taskAssert(!hasBinding, 'TASK_UNSUPPORTED');
    return { task: null };
  }
  const task = isAgentToolInvocationJob(job) ? await repo.findTaskForRun(job.session_id!, job.agent_session_id) : null;
  if (!task) {
    taskAssert(!hasBinding, 'TASK_BINDING_CONFLICT');
    await assertAgentLegacyTaskAllowedFor(config, job.agent_session_id);
    return { task: null, beforeDispatch: () => assertAgentLegacyTaskAllowedFor(config, job.agent_session_id!) };
  }
  taskAssert(isAgentToolInvocationJob(job), 'TASK_UNSUPPORTED');
  const sessionId = taskUuid(job.agent_session_id);
  const invocationId = taskDigest(job.metadata.agent_invocation_id);
  const runId = taskUuid(job.session_id);
  let permitId: string | null = null;
  return { task, taskControl: {
    async prepare(input) {
      taskAssert(input.tool === job.metadata.agent_tool && input.argsHash === job.metadata.agent_args_hash, 'TASK_INVOCATION_CONFLICT');
      const contract = { schema_version: 'bailing.agent-task-tool-contract.v1', readonly: input.readonly,
        approval_required: input.approvalRequired, args_hash: input.argsHash,
        execution_fingerprint: taskDigest(job.metadata.agent_execution_fingerprint) };
      await repo.freezeInvocationContract(job.job_id, contract);
      await repo.reserveInvocation({ taskId: task.taskId, sessionId, invocationId, runId, jobId: job.job_id,
        tool: input.tool, argsHash: input.argsHash, executionFingerprint: taskDigest(job.metadata.agent_execution_fingerprint),
        readonly: input.readonly, approvalRequired: input.approvalRequired });
    },
    async grant(input) {
      taskAssert(input.tool === job.metadata.agent_tool && input.argsHash === job.metadata.agent_args_hash, 'TASK_INVOCATION_CONFLICT');
      const result = await repo.grantDispatchPermit({ taskId: task.taskId, sessionId, invocationId, retryOriginal: true,
        ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
        journal: { scope: input.scope, idempotencyKey: input.idempotencyKey } }).catch((error: unknown) => {
        if (error instanceof AgentTaskControlError) throw error;
        throw new AgentTaskControlError('TASK_DISPATCH_UNCERTAIN');
      });
      if (result.fresh) { taskAssert(result.invocation.permitId, 'TASK_RECORD_INVALID'); permitId = result.invocation.permitId; }
      return result.fresh;
    },
    async settle(outcome, response, evidenceDegraded) {
      taskAssert(permitId, 'TASK_PERMIT_CONFLICT');
      await repo.settlePermit({ taskId: task.taskId, sessionId, invocationId, permitId, outcome,
        terminal: outcome === 'confirmed_dispatched', ...(response ? { response } : {}),
        ...(evidenceDegraded ? { evidenceDegraded: true } : {}) });
    },
  } };
}

/** Legacy model/builtin jobs must not bypass an enrolled Session's task gate. */
export async function assertTaskLegacyJobAllowedFor(config: ConfigStoreContract | null, job: Job): Promise<void> {
  taskAssert(!job.metadata.agent_task_binding && !job.metadata.agent_task_id, 'TASK_UNSUPPORTED');
  if (job.agent_session_id) await assertAgentLegacyTaskAllowedFor(config, job.agent_session_id);
}
