import { createHash } from 'node:crypto';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { AgentToolAuthContext } from './agent-tool-invocations';
import {
  AgentTaskControlError, assertTaskCanDispatch, taskAssert, taskDigest, taskInteger, taskText, taskUuid,
  normalizeAgentTaskMembers, normalizeAgentTaskPolicy,
  type AgentControlledTask, type AgentTaskMember, type AgentTaskMemberInput, type AgentTaskInvocation,
} from '../core/runtime/agent-task-control';

export const AGENT_TASK_SCHEMA = 'bailing.agent-task.v1';
export const AGENT_TASK_BINDING_SCHEMA = 'bailing.agent-task-binding.v1';
export const AGENT_TASK_CAPABILITIES_SCHEMA = 'bailing.agent-task-control-capabilities.v1';
export interface AgentTaskBinding {
  schema_version: typeof AGENT_TASK_BINDING_SCHEMA;
  task_id: string;
  scope_hash: string;
}
function record(value: unknown): Record<string, unknown> {
  taskAssert(value && typeof value === 'object' && !Array.isArray(value), 'TASK_INVALID_INPUT');
  return value as Record<string, unknown>;
}
function exact(value: unknown, fields: string[]): Record<string, unknown> {
  const result = record(value);
  taskAssert(Object.keys(result).length === fields.length && fields.every((key) => Object.hasOwn(result, key)), 'TASK_INVALID_INPUT');
  return result;
}
export function parseAgentTaskBinding(value: unknown): AgentTaskBinding {
  const body = exact(value, ['schema_version', 'task_id', 'scope_hash']);
  taskAssert(body.schema_version === AGENT_TASK_BINDING_SCHEMA, 'TASK_UNSUPPORTED');
  return { schema_version: AGENT_TASK_BINDING_SCHEMA, task_id: taskUuid(body.task_id), scope_hash: taskDigest(body.scope_hash) };
}
export function bindingForTask(task: AgentControlledTask): AgentTaskBinding {
  return { schema_version: AGENT_TASK_BINDING_SCHEMA, task_id: task.taskId, scope_hash: task.scopeHash };
}
export async function taskRepository(store: ConfigStoreContract | null) {
  const repo = store?.agentTaskControl;
  taskAssert(repo && await repo.supportsTaskControl(), 'TASK_UNSUPPORTED');
  return repo;
}
export async function agentTaskCapabilitiesFor(store: ConfigStoreContract | null, auth: AgentToolAuthContext, runtimeWired: boolean) {
  const repo = store?.agentTaskControl;
  const available = Boolean(repo && await repo.supportsTaskControl());
  const supported = Boolean(runtimeWired && store?.agentClientRuntime && available);
  const marker = available ? await repo!.getEnforcement(auth.session.session_id) : null;
  return { schema_version: AGENT_TASK_CAPABILITIES_SCHEMA, supported, mode: marker ? 'required' : 'optional',
    task_schema: AGENT_TASK_SCHEMA, metering: 'write_invocation', same_hub_only: true,
    controls: ['pause', 'resume', 'cancel'], inspect_invocation: supported };
}
function memberView(member: AgentTaskMember) {
  return { session_id: member.sessionId, client_app_id: member.clientAppId, workspace: member.route,
    client_conversation_id: member.clientConversationId, allowed_tools: [...member.allowedTools] };
}
function commonView(task: AgentControlledTask) {
  return { schema_version: AGENT_TASK_SCHEMA, task_id: task.taskId, state: task.state,
    revision: task.revision, ledger_sequence: task.ledgerSequence, scope_hash: task.scopeHash, member_count: task.members.length,
    policy: { max_write_calls: task.policy.maxWriteCalls, max_concurrent: task.policy.maxConcurrent, expires_at: task.policy.expiresAt },
    counters: { write_reserved: task.writeReserved, write_consumed: task.writeConsumed, active_permits: task.activePermits },
    metering: 'write_invocation', snapshot_is_dispatch_permission: false };
}
export function adminTaskView(task: AgentControlledTask) {
  return { ...commonView(task), members: task.members.map(memberView), created_at: task.createdAt, updated_at: task.updatedAt };
}
export async function inspectAgentTaskFor(store: ConfigStoreContract | null, auth: AgentToolAuthContext,
  id: string, workspace: string, conversation: string) {
  const repo = await taskRepository(store);
  const member = { sessionId: auth.session.session_id, clientAppId: auth.client.app_id,
    route: taskText(workspace, 64), clientConversationId: taskText(conversation, 128) };
  const task = await repo.validateMember(taskUuid(id), member);
  const selected = task.members.find((item) => item.sessionId === member.sessionId && item.clientAppId === member.clientAppId
    && item.route === member.route && item.clientConversationId === member.clientConversationId);
  taskAssert(selected, 'TASK_MEMBER_MISMATCH');
  return { ...commonView(task), member: memberView(selected) };
}
/** Before any message/context/run is created; no default task and no auto enrollment. */
export async function admitAgentTaskTurnFor(store: ConfigStoreContract | null, auth: AgentToolAuthContext,
  workspace: string, conversation: string, rawBinding: unknown): Promise<AgentControlledTask | null> {
  const repo = store?.agentTaskControl;
  if (rawBinding === undefined) {
    if (repo && await repo.supportsTaskControl()) taskAssert(!await repo.getEnforcement(auth.session.session_id), 'TASK_REQUIRED');
    return null;
  }
  const binding = parseAgentTaskBinding(rawBinding);
  const available = await taskRepository(store);
  const task = await available.validateMember(binding.task_id, { sessionId: auth.session.session_id,
    clientAppId: auth.client.app_id, route: workspace, clientConversationId: conversation }, binding.scope_hash);
  assertTaskCanDispatch(task, new Date().toISOString());
  return task;
}
/** Check the original run for new calls and existing invocation recovery, never trust metadata supplied by the model. */
export async function resolveAgentTaskRunFor(store: ConfigStoreContract | null, auth: AgentToolAuthContext,
  runId: string, workspace: string, requireActiveRun: boolean): Promise<AgentControlledTask | null> {
  const repo = store?.agentTaskControl;
  if (!repo || !await repo.supportsTaskControl()) return null;
  const task = await repo.findTaskForRun(runId, auth.session.session_id);
  if (!task) {
    taskAssert(!await repo.getEnforcement(auth.session.session_id), 'TASK_REQUIRED');
    return null;
  }
  const run = await store!.agentClientRuntime?.findRunForInvocation(runId);
  taskAssert(run && run.session_id === auth.session.session_id && run.client_app_id === auth.client.app_id
    && run.route_key === workspace, 'TASK_BINDING_CONFLICT');
  if (requireActiveRun) taskAssert(run.status === 'context_ready' && !run.completed_at, 'TASK_RUN_INACTIVE');
  return repo.validateMember(task.taskId, { sessionId: auth.session.session_id, clientAppId: auth.client.app_id,
    route: workspace, clientConversationId: run.client_conversation_id }, task.scopeHash);
}
export async function assertAgentLegacyTaskAllowedFor(store: ConfigStoreContract | null, sessionId: string): Promise<void> {
  const repo = store?.agentTaskControl;
  if (repo && await repo.supportsTaskControl()) await repo.assertUnmanagedDispatch(sessionId);
}
function policyFromWire(raw: unknown) {
  const p = exact(raw, ['max_write_calls', 'max_concurrent', 'expires_at']);
  return normalizeAgentTaskPolicy({ maxWriteCalls: p.max_write_calls as number | null,
    maxConcurrent: p.max_concurrent as number, expiresAt: p.expires_at as string | null });
}
function membersFromWire(raw: unknown): AgentTaskMemberInput[] {
  taskAssert(Array.isArray(raw), 'TASK_INVALID_INPUT');
  return normalizeAgentTaskMembers(raw.map((item) => {
    const m = exact(item, ['session_id', 'client_app_id', 'workspace', 'client_conversation_id', 'allowed_tools']);
    return { sessionId: m.session_id as string, clientAppId: m.client_app_id as string, route: m.workspace as string,
      clientConversationId: m.client_conversation_id as string, allowedTools: m.allowed_tools as string[] };
  }));
}
/** The authenticated admin and request ID define a stable server-generated task identity. */
function taskIdForRequest(actor: string, requestId: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['bailing.agent-task-create.v1', actor, requestId])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function createAdminAgentTaskFor(store: ConfigStoreContract | null, actor: string, raw: unknown) {
  const body = exact(raw, ['request_id', 'members', 'policy']);
  actor = taskText(actor, 191);
  const requestId = taskText(body.request_id, 128);
  const repo = await taskRepository(store);
  const task = await repo.createAdminTask({ taskId: taskIdForRequest(actor, requestId), actor, requestId,
    members: membersFromWire(body.members), policy: policyFromWire(body.policy) });
  return adminTaskView(task);
}
function pagination(query: URLSearchParams) {
  const limit = query.has('limit') ? taskInteger(Number(query.get('limit')), 1, 100) : 30;
  const before = query.get('before') ?? undefined;
  if (before) taskUuid(before);
  return { limit, ...(before ? { before } : {}) };
}
export async function listAdminAgentTasksFor(store: ConfigStoreContract | null, query: URLSearchParams) {
  const page = await (await taskRepository(store)).listTasks(pagination(query));
  return { items: page.items.map(adminTaskView), next_cursor: page.nextCursor };
}
function invocationView(value: AgentTaskInvocation) {
  return { session_id: value.sessionId, invocation_id: value.invocationId, run_id: value.runId, job_id: value.jobId,
    tool: value.tool, readonly: value.readonly, budget_state: value.budgetState, permit_state: value.permitState,
    outcome: value.outcome, terminal: value.terminal, attempt: value.attempt, approval_id: value.approvalId };
}
export async function getAdminAgentTaskFor(store: ConfigStoreContract | null, id: string, query: URLSearchParams) {
  const repo = await taskRepository(store);
  const task = await repo.getTask(taskUuid(id));
  taskAssert(task, 'TASK_NOT_FOUND');
  const invocations = await repo.listInvocations(task.taskId, pagination(query));
  return { task: adminTaskView(task), invocations: invocations.items.map(invocationView), next_cursor: invocations.nextCursor };
}
export async function controlAdminAgentTaskFor(store: ConfigStoreContract | null, actor: string, id: string, raw: unknown) {
  const body = exact(raw, ['request_id', 'expected_revision', 'action']);
  taskAssert(['pause', 'resume', 'cancel'].includes(String(body.action)), 'TASK_INVALID_INPUT');
  const result = await (await taskRepository(store)).controlTask({ taskId: taskUuid(id), actor: taskText(actor, 191),
    requestId: taskText(body.request_id, 128), expectedRevision: taskInteger(body.expected_revision, 1),
    action: body.action as 'pause' | 'resume' | 'cancel' });
  return adminTaskView(result);
}
export function taskErrorStatus(error: AgentTaskControlError): number {
  if (error.code === 'TASK_INVALID_INPUT') return 400;
  if (error.code === 'TASK_NOT_FOUND') return 404;
  if (error.code === 'TASK_UNSUPPORTED') return 501;
  if (error.code === 'TASK_UNAVAILABLE') return 503;
  return 409;
}
/** Keep storage-integrity details private; uncertain original attempts must never look safe to repeat. */
export function publicAgentTaskError(error: AgentTaskControlError): AgentTaskControlError {
  if (['TASK_ORIGINAL_ALREADY_ATTEMPTED', 'TASK_PERMIT_CONFLICT', 'TASK_JOURNAL_CONFLICT', 'TASK_DISPATCH_UNCERTAIN'].includes(error.code)) {
    return new AgentTaskControlError('TASK_DISPATCH_UNCERTAIN');
  }
  if (['TASK_RUN_CONFLICT', 'TASK_RUN_TASK_CONFLICT', 'TASK_INVOCATION_CONFLICT'].includes(error.code)) {
    return new AgentTaskControlError('TASK_BINDING_CONFLICT');
  }
  const publicCodes = ['TASK_REQUIRED', 'TASK_UNSUPPORTED', 'TASK_SCOPE_BLOCKED', 'TASK_MEMBER_MISMATCH',
    'TASK_BINDING_CONFLICT', 'TASK_PAUSED', 'TASK_CANCELLED', 'TASK_EXPIRED', 'TASK_WRITE_BUDGET_EXHAUSTED',
    'TASK_CONCURRENCY_EXHAUSTED', 'TASK_TOOL_NOT_ALLOWED', 'TASK_REVISION_CONFLICT', 'TASK_RECORD_INVALID',
    'TASK_UNAVAILABLE', 'TASK_NOT_FOUND', 'TASK_RUN_INACTIVE', 'TASK_INVALID_INPUT'];
  return publicCodes.includes(error.code) ? error : new AgentTaskControlError('TASK_RECORD_INVALID');
}
