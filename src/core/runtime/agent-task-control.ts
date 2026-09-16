import { createHash } from 'node:crypto';

/** Internal foundation only. No HTTP admission or enforcement is wired to these types yet. */
export type AgentTaskState = 'active' | 'paused' | 'blocked' | 'cancelled';
export type AgentTaskBudgetState = 'reserved' | 'consumed' | 'released' | null;
export type AgentTaskPermitState = 'none' | 'held' | 'unknown' | 'settled';
export type AgentTaskOutcome = 'confirmed_dispatched' | 'confirmed_not_dispatched' | 'unknown';

export interface AgentTaskPolicy {
  /** null disables this task's cumulative write-call limit; 0 permits reads only. */
  maxWriteCalls: number | null;
  maxConcurrent: number;
  expiresAt: string | null;
}

export interface AgentTaskMemberInput {
  sessionId: string;
  clientAppId: string;
  route: string;
  clientConversationId: string;
  allowedTools: string[];
}
export interface AgentTaskMember extends AgentTaskMemberInput { identityHash: string }

export interface AgentControlledTask {
  taskId: string;
  state: AgentTaskState;
  revision: number;
  ledgerSequence: number;
  policy: AgentTaskPolicy;
  members: AgentTaskMember[];
  scopeHash: string;
  writeReserved: number;
  writeConsumed: number;
  activePermits: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskInvocation {
  taskId: string;
  sessionId: string;
  invocationId: string;
  runId: string;
  jobId: string;
  tool: string;
  argsHash: string;
  executionFingerprint: string;
  readonly: boolean;
  approvalRequired: boolean;
  approvalId: number | null;
  budgetState: AgentTaskBudgetState;
  permitId: string | null;
  permitState: AgentTaskPermitState;
  outcome: AgentTaskOutcome | null;
  terminal: boolean;
  attempt: number;
}

export interface CreateAgentTaskInput {
  taskId: string;
  requestId: string;
  /** Captured from an authenticated administrator by the future admission layer. */
  actor: string;
  members: AgentTaskMemberInput[];
  policy: AgentTaskPolicy;
}
export interface ControlAgentTaskInput {
  taskId: string;
  expectedRevision: number;
  requestId: string;
  actor: string;
  action: 'pause' | 'resume' | 'cancel';
}
export interface ReserveAgentTaskInvocationInput {
  taskId: string;
  sessionId: string;
  invocationId: string;
  runId: string;
  jobId: string;
  tool: string;
  argsHash: string;
  executionFingerprint: string;
  /** Must come from the current Core tool declaration, never model input. */
  readonly: boolean;
  approvalRequired: boolean;
}
export interface GrantAgentTaskPermitInput {
  taskId: string;
  sessionId: string;
  invocationId: string;
  /** Required only for a confirmed-not-dispatched, nonterminal prior attempt. */
  retryOriginal?: boolean;
  approvalId?: number;
}
export interface SettleAgentTaskPermitInput {
  taskId: string;
  sessionId: string;
  invocationId: string;
  permitId: string;
  /** Only the trusted execution/evidence layer may supply these observations. */
  outcome: AgentTaskOutcome;
  terminal: boolean;
}
export interface ReleaseAgentTaskReservationInput {
  taskId: string;
  sessionId: string;
  invocationId: string;
  reason: 'approval_denied' | 'abandoned';
  /** Original approval evidence for denial; an authenticated admin for abandonment. */
  approvalId?: number;
  actor?: string;
}
export interface AgentTaskPermitResult { fresh: boolean; invocation: AgentTaskInvocation; task: AgentControlledTask }

export class AgentTaskControlError extends Error {
  override readonly name = 'AgentTaskControlError';
  constructor(readonly code: string, message = 'The governed task operation could not be accepted.') { super(message); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const ROUTE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const TOOL = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export function taskAssert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new AgentTaskControlError(code);
}
export function taskUuid(value: unknown): string {
  taskAssert(typeof value === 'string' && UUID.test(value), 'TASK_INVALID_INPUT');
  return value.toLowerCase();
}
export function taskDigest(value: unknown): string {
  taskAssert(typeof value === 'string' && DIGEST.test(value), 'TASK_INVALID_INPUT');
  return value;
}
export function taskText(value: unknown, max: number): string {
  taskAssert(typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value), 'TASK_INVALID_INPUT');
  return value;
}
export function taskInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  taskAssert(Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max, 'TASK_INVALID_INPUT');
  return Number(value);
}
function exact(value: object, fields: string[]) {
  taskAssert(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => fields.includes(key))
    && fields.every((key) => Object.prototype.hasOwnProperty.call(value, key)), 'TASK_INVALID_INPUT');
}
export function normalizeAgentTaskPolicy(value: AgentTaskPolicy): AgentTaskPolicy {
  exact(value, ['maxWriteCalls', 'maxConcurrent', 'expiresAt']);
  const expiresAt = value.expiresAt;
  taskAssert(expiresAt === null || (typeof expiresAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(expiresAt)
    && Number.isFinite(Date.parse(expiresAt))), 'TASK_INVALID_INPUT');
  if (expiresAt !== null) {
    const normalized = new Date(expiresAt).toISOString();
    const exactCalendar = expiresAt.replace(/(?:\.(\d{1,3}))?Z$/, (_match, digits) => `.${String(digits ?? '').padEnd(3, '0')}Z`);
    taskAssert(normalized === exactCalendar && Number(expiresAt.slice(0, 4)) >= 1000, 'TASK_INVALID_INPUT');
  }
  return { maxWriteCalls: value.maxWriteCalls === null ? null : taskInteger(value.maxWriteCalls, 0, 1_000_000_000),
    maxConcurrent: taskInteger(value.maxConcurrent, 1, 10_000), expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString() };
}
export function normalizeAgentTaskMembers(input: AgentTaskMemberInput[]): AgentTaskMemberInput[] {
  taskAssert(Array.isArray(input) && input.length > 0 && input.length <= 64, 'TASK_INVALID_INPUT');
  const keys = new Set<string>();
  return input.map((member) => {
    exact(member, ['sessionId', 'clientAppId', 'route', 'clientConversationId', 'allowedTools']);
    const value = { sessionId: taskUuid(member.sessionId), clientAppId: taskText(member.clientAppId, 64),
      route: taskText(member.route, 64), clientConversationId: taskText(member.clientConversationId, 128), allowedTools: [] as string[] };
    taskAssert(ROUTE.test(value.route) && value.route !== 'auto', 'TASK_INVALID_INPUT');
    taskAssert(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.clientConversationId), 'TASK_INVALID_INPUT');
    taskAssert(Array.isArray(member.allowedTools) && member.allowedTools.length > 0 && member.allowedTools.length <= 256
      && member.allowedTools.every((tool) => typeof tool === 'string' && TOOL.test(tool))
      && new Set(member.allowedTools).size === member.allowedTools.length, 'TASK_INVALID_INPUT');
    value.allowedTools = [...member.allowedTools].sort();
    const key = agentTaskMemberKey(value);
    taskAssert(!keys.has(key), 'TASK_INVALID_INPUT'); keys.add(key);
    return value;
  }).sort((a, b) => compareTaskStrings(agentTaskMemberKey(a), agentTaskMemberKey(b)));
}
/** Stable byte-representable ordering, independent of ICU/locale collation equivalence. */
export function compareTaskStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function agentTaskMemberKey(member: Pick<AgentTaskMemberInput, 'sessionId' | 'route' | 'clientConversationId'>): string {
  return JSON.stringify([member.sessionId, member.route, member.clientConversationId]);
}
export function agentTaskHash(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item && typeof item === 'object') return `{${Object.entries(item).sort(([a], [b]) => compareTaskStrings(a, b))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(',')}}`;
    return JSON.stringify(item) ?? 'null';
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function assertTaskCanDispatch(task: AgentControlledTask, now: string): void {
  taskAssert(task.state === 'active', task.state === 'cancelled' ? 'TASK_CANCELLED' : task.state === 'blocked' ? 'TASK_SCOPE_BLOCKED' : 'TASK_PAUSED');
  taskAssert(task.policy.expiresAt === null || Date.parse(task.policy.expiresAt) > Date.parse(now), 'TASK_EXPIRED');
}
export function transitionAgentTask(state: AgentTaskState, action: ControlAgentTaskInput['action']): AgentTaskState {
  taskAssert(state !== 'cancelled', 'TASK_CANCELLED');
  if (action === 'cancel') return 'cancelled';
  if (action === 'pause') return 'paused';
  taskAssert(action === 'resume' && state === 'paused', 'TASK_CONTROL_CONFLICT');
  return 'active';
}
export function assertTaskWriteCapacity(task: AgentControlledTask): void {
  taskAssert(task.policy.maxWriteCalls === null || task.writeReserved + task.writeConsumed < task.policy.maxWriteCalls, 'TASK_WRITE_BUDGET_EXHAUSTED');
}
export function validateTaskInvocation(input: ReserveAgentTaskInvocationInput): ReserveAgentTaskInvocationInput {
  exact(input, ['taskId', 'sessionId', 'invocationId', 'runId', 'jobId', 'tool', 'argsHash', 'executionFingerprint', 'readonly', 'approvalRequired']);
  taskAssert(typeof input.tool === 'string' && TOOL.test(input.tool)
    && typeof input.readonly === 'boolean' && typeof input.approvalRequired === 'boolean', 'TASK_INVALID_INPUT');
  return { taskId: taskUuid(input.taskId), sessionId: taskUuid(input.sessionId), invocationId: taskDigest(input.invocationId),
    runId: taskUuid(input.runId), jobId: taskUuid(input.jobId), tool: input.tool, argsHash: taskDigest(input.argsHash),
    executionFingerprint: taskDigest(input.executionFingerprint), readonly: input.readonly, approvalRequired: input.approvalRequired };
}
