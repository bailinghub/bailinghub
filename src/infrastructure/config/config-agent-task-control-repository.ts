import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { audienceAllows } from '../../core/runtime/identity-runtime';
import { agentDirectToolsConfig } from '../../core/config/tools-config';
import { routeAgentClientConfig } from '../../core/config/route-config';
import { isAgentToolInvocationJob } from '../../app/agent-tool-job';
import { rowToJob } from '../../core/state/state-codec';
import {
  AgentTaskControlError, agentTaskHash, agentTaskMemberKey, assertTaskCanDispatch, assertTaskWriteCapacity,
  normalizeAgentTaskMembers, normalizeAgentTaskPolicy, taskAssert, taskDigest, taskInteger, taskText, taskUuid,
  transitionAgentTask, validateTaskInvocation, compareTaskStrings,
  type AgentControlledTask, type AgentTaskInvocation, type AgentTaskMember, type AgentTaskMemberInput,
  type AgentTaskPermitResult, type ControlAgentTaskInput, type CreateAgentTaskInput,
  type GrantAgentTaskPermitInput, type ReserveAgentTaskInvocationInput, type SettleAgentTaskPermitInput,
  type ReleaseAgentTaskReservationInput,
} from '../../core/runtime/agent-task-control';

type Row = Record<string, any>;
type LockedBindings = { sessions: Map<string, Row>; clients: Map<string, Row>; routes: Map<string, Row> };
const SESSION_COLUMNS = 'session_id,client_app_id,principal_json,on_behalf_of,allowed_routes,refresh_expires_at,created_at,revoked_at';
const ACTIVE_RUN = 'context_ready';

function object(value: unknown): Row {
  try {
    const decoded = typeof value === 'string' ? JSON.parse(value) : value;
    taskAssert(decoded && typeof decoded === 'object' && !Array.isArray(decoded), 'TASK_RECORD_INVALID');
    return decoded;
  } catch { throw new AgentTaskControlError('TASK_RECORD_INVALID'); }
}
function strings(value: unknown): string[] {
  try {
    const decoded = typeof value === 'string' ? JSON.parse(value) : value;
    taskAssert(Array.isArray(decoded) && decoded.every((item) => typeof item === 'string'), 'TASK_RECORD_INVALID');
    return decoded;
  } catch { throw new AgentTaskControlError('TASK_RECORD_INVALID'); }
}
function date(value: unknown): string {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value).replace(' ', 'T').replace(/(?<!Z)$/, 'Z'));
  taskAssert(Number.isFinite(time), 'TASK_RECORD_INVALID');
  return new Date(time).toISOString();
}
function sqlDate(value: string): string { return value.replace('T', ' ').replace(/Z$/, ''); }
function safeCount(value: unknown): number {
  const count = Number(value); taskAssert(Number.isSafeInteger(count) && count >= 0, 'TASK_RECORD_INVALID'); return count;
}
function memberRow(row: Row): AgentTaskMember {
  const member = normalizeAgentTaskMembers([{ sessionId: row.session_id, clientAppId: row.client_app_id,
    route: row.route_key, clientConversationId: row.client_conversation_id, allowedTools: strings(row.allowed_tools_json) }])[0]!;
  return { ...member, identityHash: taskDigest(row.identity_hash) };
}
function taskRow(row: Row, members: AgentTaskMember[]): AgentControlledTask {
  taskAssert(['active', 'paused', 'blocked', 'cancelled'].includes(row.state), 'TASK_RECORD_INVALID');
  taskAssert(members.length > 0 && members.length <= 64 && agentTaskHash(members) === row.scope_hash, 'TASK_RECORD_INVALID');
  return { taskId: taskUuid(row.task_id), state: row.state, revision: taskInteger(safeCount(row.revision), 1),
    ledgerSequence: taskInteger(safeCount(row.ledger_sequence), 1), policy: normalizeAgentTaskPolicy(object(row.policy_json) as any),
    members, scopeHash: taskDigest(row.scope_hash), writeReserved: safeCount(row.write_reserved), writeConsumed: safeCount(row.write_consumed),
    activePermits: safeCount(row.active_permits), createdBy: taskText(row.created_by, 191),
    createdAt: date(row.created_at), updatedAt: date(row.updated_at) };
}
function invocationRow(row: Row): AgentTaskInvocation {
  taskAssert([0, 1].includes(Number(row.is_readonly)) && [0, 1].includes(Number(row.approval_required))
    && [0, 1].includes(Number(row.is_terminal)) && ['none', 'held', 'unknown', 'settled'].includes(row.permit_state)
    && [null, 'reserved', 'consumed', 'released'].includes(row.budget_state)
    && [null, 'confirmed_dispatched', 'confirmed_not_dispatched', 'unknown'].includes(row.outcome), 'TASK_RECORD_INVALID');
  const readonly = Number(row.is_readonly) === 1;
  taskAssert(readonly ? row.budget_state === null : row.budget_state !== null, 'TASK_RECORD_INVALID');
  return { taskId: taskUuid(row.task_id), sessionId: taskUuid(row.session_id), invocationId: taskDigest(row.invocation_id),
    runId: taskUuid(row.run_id), jobId: taskUuid(row.job_id), tool: taskText(row.tool, 64), argsHash: taskDigest(row.args_hash),
    executionFingerprint: taskDigest(row.execution_fingerprint), readonly, approvalRequired: Number(row.approval_required) === 1,
    approvalId: row.approval_id === null ? null : taskInteger(Number(row.approval_id), 1),
    budgetState: row.budget_state, permitId: row.permit_id === null ? null : taskUuid(row.permit_id),
    permitState: row.permit_state, outcome: row.outcome, terminal: Number(row.is_terminal) === 1, attempt: safeCount(row.attempt) };
}

/**
 * Unwired MySQL foundation. All methods are internal trusted services, not Agent HTTP APIs.
 * getTask includes identity hashes and multi-member state: admission and output projection
 * must be implemented before exposing it. This class performs no business HTTP requests.
 */
export class AgentTaskControlRepository {
  constructor(private readonly poolOf: () => Pool,
    private readonly options: { now?: () => string; newId?: () => string } = {}) {}
  private now(): string { return date((this.options.now ?? (() => new Date().toISOString()))()); }
  private async tx<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.poolOf().getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new AgentTaskControlError('TASK_CONFLICT');
      throw error;
    } finally { connection.release(); }
  }
  private async rows(connection: Pick<PoolConnection, 'query'> | Pool, sql: string, values: unknown[] = []): Promise<Row[]> {
    const [rows] = await connection.query(sql, values); return rows as Row[];
  }
  private async members(connection: Pick<PoolConnection, 'query'> | Pool, taskId: string, lock = false): Promise<AgentTaskMember[]> {
    const rows = await this.rows(connection, `SELECT * FROM bz_agent_task_members WHERE task_id=? ORDER BY member_key${lock ? ' FOR UPDATE' : ''}`, [taskId]);
    return rows.map(memberRow).sort((a, b) => compareTaskStrings(agentTaskMemberKey(a), agentTaskMemberKey(b)));
  }
  private async lockBindings(connection: PoolConnection, members: AgentTaskMemberInput[]): Promise<LockedBindings> {
    const bindings: LockedBindings = { clients: new Map(), routes: new Map(), sessions: new Map() };
    // Match conversation-audit ordering: all clients, all routes, all Sessions, then task.
    for (const id of [...new Set(members.map((member) => member.clientAppId))].sort()) {
      const [row] = await this.rows(connection, 'SELECT app_id,enabled,allowed_routes,agent_authorize_url FROM bz_clients WHERE app_id=? FOR UPDATE', [id]);
      if (row) bindings.clients.set(id, row);
    }
    for (const route of [...new Set(members.map((member) => member.route))].sort()) {
      const [row] = await this.rows(connection, 'SELECT route_key,enabled,audience,tools,agent_client FROM bz_routes WHERE route_key=? FOR UPDATE', [route]);
      if (row) bindings.routes.set(route, row);
    }
    for (const id of [...new Set(members.map((member) => member.sessionId))].sort()) {
      const [row] = await this.rows(connection, `SELECT ${SESSION_COLUMNS} FROM bz_agent_sessions WHERE session_id=? FOR UPDATE`, [id]);
      if (row) bindings.sessions.set(id, row);
    }
    return bindings;
  }
  private verifyMembers(members: AgentTaskMemberInput[], bindings: LockedBindings, now: string): AgentTaskMember[] {
    return members.map((member) => {
      const session = bindings.sessions.get(member.sessionId);
      const client = bindings.clients.get(member.clientAppId);
      const route = bindings.routes.get(member.route);
      taskAssert(session && client && route && session.session_id === member.sessionId
        && session.client_app_id === member.clientAppId && client.app_id === member.clientAppId && route.route_key === member.route,
      'TASK_SCOPE_BLOCKED');
      taskAssert(Number(client.enabled) === 1 && Number(route.enabled) === 1 && !session.revoked_at
        && typeof client.agent_authorize_url === 'string' && client.agent_authorize_url.length > 0
        && Date.parse(date(session.refresh_expires_at)) > Date.parse(now), 'TASK_SCOPE_BLOCKED');
      const principal = object(session.principal_json);
      taskAssert(typeof principal.id === 'string' && Array.isArray(principal.roles)
        && principal.roles.every((role: unknown) => typeof role === 'string') && typeof session.on_behalf_of === 'string', 'TASK_SCOPE_BLOCKED');
      const allowed = (values: unknown) => { const list = strings(values); return list.includes('*') || list.includes(member.route); };
      const tools = object(route.tools);
      taskAssert(allowed(session.allowed_routes) && allowed(client.allowed_routes)
        && !!agentDirectToolsConfig(tools) && !!routeAgentClientConfig({ tools,
          ...(route.agent_client ? { agent_client: object(route.agent_client) } : {}) }), 'TASK_SCOPE_BLOCKED');
      const audience = route.audience ? object(route.audience) : undefined;
      taskAssert(audienceAllows(audience, { ...principal, id: principal.id, roles: principal.roles,
        client_app_id: member.clientAppId, channel: principal.channel ?? `agent:${member.clientAppId}` }).ok, 'TASK_SCOPE_BLOCKED');
      const identityHash = agentTaskHash({ sessionId: member.sessionId, clientAppId: member.clientAppId,
        principal: { ...principal, roles: [...principal.roles].sort() }, onBehalfOf: session.on_behalf_of,
        createdAt: date(session.created_at) });
      if ('identityHash' in member) taskAssert(member.identityHash === identityHash, 'TASK_SCOPE_BLOCKED');
      return { ...member, allowedTools: [...member.allowedTools], identityHash };
    });
  }
  private async saveTask(connection: PoolConnection, task: AgentControlledTask): Promise<void> {
    for (const value of [task.revision, task.ledgerSequence, task.writeReserved, task.writeConsumed, task.activePermits]) safeCount(value);
    await connection.query('UPDATE bz_agent_tasks SET state=?,revision=?,ledger_sequence=?,write_reserved=?,write_consumed=?,active_permits=?,updated_at=? WHERE task_id=?',
      [task.state, task.revision, task.ledgerSequence, task.writeReserved, task.writeConsumed, task.activePermits, sqlDate(task.updatedAt), task.taskId]);
  }
  private async event(connection: PoolConnection, task: AgentControlledTask, event: string,
    values: { actor?: string; requestKey?: string; requestHash?: string; invocationId?: string; permitId?: string; detail?: Row } = {}) {
    await connection.query('INSERT INTO bz_agent_task_events (task_id,sequence,event,request_key,request_hash,actor,invocation_id,permit_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [task.taskId, task.ledgerSequence, event, values.requestKey ?? null, values.requestHash ?? null, values.actor ?? null,
        values.invocationId ?? null, values.permitId ?? null, JSON.stringify(values.detail ?? {}), sqlDate(task.updatedAt)]);
  }
  private async withTask<T>(taskId: string, requireValidMembers: boolean,
    work: (connection: PoolConnection, task: AgentControlledTask, bindings: LockedBindings) => Promise<T>): Promise<T> {
    taskId = taskUuid(taskId);
    const located = await this.members(this.poolOf(), taskId);
    taskAssert(located.length > 0, 'TASK_NOT_FOUND');
    let blocked: AgentTaskControlError | undefined;
    const result = await this.tx(async (connection) => {
      const bindings = await this.lockBindings(connection, located);
      const [row] = await this.rows(connection, 'SELECT * FROM bz_agent_tasks WHERE task_id=? FOR UPDATE', [taskId]);
      taskAssert(row, 'TASK_NOT_FOUND');
      const members = await this.members(connection, taskId, true);
      taskAssert(agentTaskHash(members) === agentTaskHash(located), 'TASK_RECORD_INVALID');
      const task = taskRow(row, members);
      if (requireValidMembers) {
        try { this.verifyMembers(members, bindings, this.now()); }
        catch (error) {
          if (!(error instanceof AgentTaskControlError) || !['TASK_SCOPE_BLOCKED', 'TASK_RECORD_INVALID'].includes(error.code)) throw error;
          if (task.state !== 'cancelled' && task.state !== 'blocked') {
            task.state = 'blocked'; task.revision++; task.ledgerSequence++; task.updatedAt = this.now();
            await this.saveTask(connection, task); await this.event(connection, task, 'scope_blocked');
          }
          blocked = new AgentTaskControlError('TASK_SCOPE_BLOCKED');
          return undefined as T;
        }
      }
      return work(connection, task, bindings);
    });
    if (blocked) throw blocked;
    return result;
  }
  async createAdminTask(input: CreateAgentTaskInput): Promise<AgentControlledTask> {
    const taskId = taskUuid(input.taskId), actor = taskText(input.actor, 191), requestId = taskText(input.requestId, 128);
    taskAssert(Object.keys(input).every((key) => ['taskId', 'actor', 'requestId', 'members', 'policy'].includes(key)), 'TASK_INVALID_INPUT');
    const requestedMembers = normalizeAgentTaskMembers(input.members), policy = normalizeAgentTaskPolicy(input.policy);
    const createKey = agentTaskHash([actor, requestId]);
    const createHash = agentTaskHash({ taskId, actor, members: requestedMembers, policy });
    return this.tx(async (connection) => {
      const bindings = await this.lockBindings(connection, requestedMembers);
      const [existing] = await this.rows(connection, 'SELECT * FROM bz_agent_tasks WHERE task_id=? OR create_key=? FOR UPDATE', [taskId, createKey]);
      if (existing) {
        taskAssert(existing.task_id === taskId && existing.create_key === createKey && existing.create_hash === createHash, 'TASK_CONFLICT');
        return taskRow(existing, await this.members(connection, taskId));
      }
      const now = this.now();
      const members = this.verifyMembers(requestedMembers, bindings, now);
      taskAssert(policy.expiresAt === null || Date.parse(policy.expiresAt) > Date.parse(now), 'TASK_EXPIRED');
      const task: AgentControlledTask = { taskId, state: 'active', revision: 1, ledgerSequence: 1, policy, members,
        scopeHash: agentTaskHash(members), writeReserved: 0, writeConsumed: 0, activePermits: 0,
        createdBy: actor, createdAt: now, updatedAt: now };
      await connection.query('INSERT INTO bz_agent_tasks (task_id,create_key,create_hash,state,revision,ledger_sequence,policy_json,scope_hash,write_reserved,write_consumed,active_permits,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [taskId, createKey, createHash, task.state, 1, 1, JSON.stringify(policy), task.scopeHash, 0, 0, 0, actor, sqlDate(now), sqlDate(now)]);
      for (const member of members) {
        await connection.query('INSERT INTO bz_agent_task_members (task_id,member_key,session_id,client_app_id,route_key,client_conversation_id,allowed_tools_json,identity_hash) VALUES (?,?,?,?,?,?,?,?)',
          [taskId, agentTaskHash(agentTaskMemberKey(member)), member.sessionId, member.clientAppId, member.route,
            member.clientConversationId, JSON.stringify(member.allowedTools), member.identityHash]);
        await connection.query('INSERT INTO bz_agent_task_enforcements (session_id,first_task_id,created_by,created_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE session_id=session_id',
          [member.sessionId, taskId, actor, sqlDate(now)]);
      }
      await this.event(connection, task, 'created', { actor, requestKey: createKey, requestHash: createHash });
      return task;
    });
  }
  /** Internal admin projection only; it contains cross-member state and identity digests. */
  async getTask(taskId: string): Promise<AgentControlledTask | null> {
    taskId = taskUuid(taskId);
    const [row] = await this.rows(this.poolOf(), 'SELECT * FROM bz_agent_tasks WHERE task_id=?', [taskId]);
    return row ? taskRow(row, await this.members(this.poolOf(), taskId)) : null;
  }
  /** This observation alone is not a final dispatch check; the future admission transaction must lock it. */
  async getEnforcement(sessionId: string): Promise<{ sessionId: string; firstTaskId: string } | null> {
    sessionId = taskUuid(sessionId);
    const [row] = await this.rows(this.poolOf(), 'SELECT session_id,first_task_id FROM bz_agent_task_enforcements WHERE session_id=?', [sessionId]);
    return row ? { sessionId: taskUuid(row.session_id), firstTaskId: taskUuid(row.first_task_id) } : null;
  }
  async controlTask(input: ControlAgentTaskInput): Promise<AgentControlledTask> {
    const taskId = taskUuid(input.taskId), actor = taskText(input.actor, 191), requestId = taskText(input.requestId, 128);
    taskInteger(input.expectedRevision, 1);
    taskAssert(['pause', 'resume', 'cancel'].includes(input.action), 'TASK_INVALID_INPUT');
    const action = input.action, expectedRevision = input.expectedRevision;
    const requestKey = agentTaskHash([actor, requestId]), requestHash = agentTaskHash({ taskId, actor, action, expectedRevision });
    return this.withTask(taskId, action === 'resume', async (connection, task) => {
      const [previous] = await this.rows(connection, 'SELECT request_hash FROM bz_agent_task_events WHERE task_id=? AND request_key=?', [taskId, requestKey]);
      if (previous) { taskAssert(previous.request_hash === requestHash, 'TASK_CONTROL_CONFLICT'); return task; }
      taskAssert(task.revision === expectedRevision, 'TASK_REVISION_CONFLICT');
      task.state = transitionAgentTask(task.state, action);
      if (action === 'resume') assertTaskCanDispatch(task, this.now());
      task.revision++; task.ledgerSequence++; task.updatedAt = this.now();
      await this.saveTask(connection, task);
      await this.event(connection, task, action, { actor, requestKey, requestHash, detail: { revision: task.revision } });
      return task;
    });
  }
  private async invocation(connection: PoolConnection, sessionId: string, invocationId: string): Promise<AgentTaskInvocation | null> {
    const [row] = await this.rows(connection, 'SELECT * FROM bz_agent_task_invocations WHERE session_id=? AND invocation_id=? FOR UPDATE', [sessionId, invocationId]);
    return row ? invocationRow(row) : null;
  }
  private async bindRun(connection: PoolConnection, invocation: ReserveAgentTaskInvocationInput, create: boolean, now: string) {
    const [binding] = await this.rows(connection, 'SELECT task_id,session_id FROM bz_agent_task_runs WHERE run_id=? FOR UPDATE', [invocation.runId]);
    if (binding) {
      taskAssert(binding.task_id === invocation.taskId && binding.session_id === invocation.sessionId, 'TASK_RUN_TASK_CONFLICT');
    } else {
      taskAssert(create, 'TASK_RUN_TASK_CONFLICT');
      await connection.query('INSERT INTO bz_agent_task_runs (run_id,task_id,session_id,created_at) VALUES (?,?,?,?)',
        [invocation.runId, invocation.taskId, invocation.sessionId, sqlDate(now)]);
    }
  }
  private async validateOriginal(connection: PoolConnection, task: AgentControlledTask,
    input: ReserveAgentTaskInvocationInput, bindings: LockedBindings, requireActiveRun: boolean) {
    const [run] = await this.rows(connection, 'SELECT run_id,session_id,client_app_id,route_key,thread_id,client_conversation_id,status,completed_at FROM bz_agent_client_runs WHERE run_id=? FOR UPDATE', [input.runId]);
    const member = task.members.find((item) => item.sessionId === input.sessionId && item.clientAppId === run?.client_app_id
      && item.route === run?.route_key && item.clientConversationId === run?.client_conversation_id);
    taskAssert(run && member && run.run_id === input.runId && run.session_id === input.sessionId, 'TASK_RUN_CONFLICT');
    if (requireActiveRun) taskAssert(run.status === ACTIVE_RUN && !run.completed_at, 'TASK_RUN_INACTIVE');
    taskAssert(member.allowedTools.includes(input.tool), 'TASK_TOOL_NOT_ALLOWED');
    const [row] = await this.rows(connection, 'SELECT * FROM bz_jobs WHERE job_id=? FOR UPDATE', [input.jobId]);
    taskAssert(row, 'TASK_INVOCATION_CONFLICT');
    const job = rowToJob(row);
    const requestId = `agent-tool:${createHash('sha256').update(`bailing.agent-tool.v1\0${input.sessionId}\0${input.invocationId}`).digest('hex')}`;
    const principal = object(bindings.sessions.get(input.sessionId)?.principal_json);
    const originalPrincipal = job.metadata.principal;
    taskAssert(isAgentToolInvocationJob(job) && job.agent_session_id === input.sessionId && job.client_app_id === member.clientAppId
      && job.job_id === input.jobId && job.request_id === requestId
      && originalPrincipal && typeof originalPrincipal === 'object' && !Array.isArray(originalPrincipal)
      && (originalPrincipal as Row).id === principal.id && (originalPrincipal as Row).tenant === principal.tenant
      && job.session_id === input.runId && job.metadata.agent_invocation_id === input.invocationId
      && (job.thread_id === undefined || job.thread_id === Number(run.thread_id))
      && job.metadata.agent_route === member.route && job.metadata.agent_tool === input.tool
      && job.metadata.agent_args_hash === input.argsHash && job.metadata.agent_execution_fingerprint === input.executionFingerprint
      && job.on_behalf_of === bindings.sessions.get(input.sessionId)?.on_behalf_of,
    'TASK_INVOCATION_CONFLICT');
    const contract = job.metadata.agent_task_tool_contract;
    taskAssert(contract && typeof contract === 'object' && !Array.isArray(contract)
      && (contract as Row).schema_version === 'bailing.agent-task-tool-contract.v1', 'TASK_CLASSIFICATION_UNAVAILABLE');
    taskAssert((contract as Row).readonly === input.readonly && (contract as Row).approval_required === input.approvalRequired
      && (contract as Row).args_hash === input.argsHash && (contract as Row).execution_fingerprint === input.executionFingerprint,
    'TASK_INVOCATION_CONFLICT');
    return job;
  }
  async reserveInvocation(value: ReserveAgentTaskInvocationInput): Promise<AgentTaskPermitResult> {
    const input = validateTaskInvocation(value);
    return this.withTask(input.taskId, true, async (connection, task, bindings) => {
      const existing = await this.invocation(connection, input.sessionId, input.invocationId);
      if (existing) {
        taskAssert(Object.entries(input).every(([key, value]) => existing[key as keyof AgentTaskInvocation] === value), 'TASK_INVOCATION_CONFLICT');
        await this.validateOriginal(connection, task, input, bindings, false);
        await this.bindRun(connection, input, false, task.updatedAt);
        return { fresh: false, invocation: existing, task };
      }
      assertTaskCanDispatch(task, this.now());
      const job = await this.validateOriginal(connection, task, input, bindings, true);
      taskAssert(job.metadata.agent_dispatch_attempted === false && !job.metadata.agent_task_id, 'TASK_ORIGINAL_ALREADY_ATTEMPTED');
      await this.bindRun(connection, input, true, this.now());
      if (!input.readonly) { assertTaskWriteCapacity(task); task.writeReserved++; }
      const invocation: AgentTaskInvocation = { ...input, approvalId: null, budgetState: input.readonly ? null : 'reserved',
        permitId: null, permitState: 'none', outcome: null, terminal: false, attempt: 0 };
      task.ledgerSequence++; task.updatedAt = this.now();
      await connection.query('INSERT INTO bz_agent_task_invocations (session_id,invocation_id,task_id,run_id,job_id,tool,args_hash,execution_fingerprint,is_readonly,approval_required,approval_id,budget_state,permit_id,permit_state,outcome,is_terminal,attempt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [input.sessionId, input.invocationId, input.taskId, input.runId, input.jobId, input.tool, input.argsHash, input.executionFingerprint,
          input.readonly ? 1 : 0, input.approvalRequired ? 1 : 0, null, invocation.budgetState, null, 'none', null, 0, 0, sqlDate(task.updatedAt), sqlDate(task.updatedAt)]);
      await connection.query("UPDATE bz_jobs SET metadata=JSON_SET(metadata,'$.agent_task_id',?),updated_at=? WHERE job_id=?", [task.taskId, sqlDate(task.updatedAt), input.jobId]);
      await this.saveTask(connection, task); await this.event(connection, task, 'invocation_reserved', { invocationId: input.invocationId });
      return { fresh: true, invocation, task };
    });
  }
  private async saveInvocation(connection: PoolConnection, invocation: AgentTaskInvocation, now: string) {
    await connection.query('UPDATE bz_agent_task_invocations SET budget_state=?,permit_id=?,permit_state=?,outcome=?,is_terminal=?,attempt=?,approval_id=?,updated_at=? WHERE session_id=? AND invocation_id=? AND task_id=?',
      [invocation.budgetState, invocation.permitId, invocation.permitState, invocation.outcome, invocation.terminal ? 1 : 0,
        invocation.attempt, invocation.approvalId, sqlDate(now), invocation.sessionId, invocation.invocationId, invocation.taskId]);
  }
  /** Finish a never-permitted original invocation without inventing a dispatch permit. */
  async releaseReservation(value: ReleaseAgentTaskReservationInput): Promise<AgentTaskPermitResult> {
    const input = { taskId: taskUuid(value.taskId), sessionId: taskUuid(value.sessionId), invocationId: taskDigest(value.invocationId),
      reason: value.reason, approvalId: value.approvalId, actor: value.actor };
    taskAssert(input.reason === 'approval_denied' || input.reason === 'abandoned', 'TASK_INVALID_INPUT');
    if (input.reason === 'approval_denied') {
      taskInteger(input.approvalId, 1); taskAssert(input.actor === undefined, 'TASK_INVALID_INPUT');
    } else {
      input.actor = taskText(input.actor, 191); taskAssert(input.approvalId === undefined, 'TASK_INVALID_INPUT');
    }
    return this.withTask(input.taskId, false, async (connection, task, bindings) => {
      const invocation = await this.invocation(connection, input.sessionId, input.invocationId);
      taskAssert(invocation && invocation.taskId === task.taskId && invocation.permitId === null
        && invocation.permitState === 'none' && invocation.attempt === 0, 'TASK_RESERVATION_NOT_RELEASABLE');
      if (invocation.terminal && invocation.outcome === 'confirmed_not_dispatched') return { fresh: false, invocation, task };
      const job = await this.validateOriginal(connection, task, invocation, bindings, false);
      await this.bindRun(connection, invocation, false, task.updatedAt);
      taskAssert(job.metadata.agent_task_id === task.taskId && job.metadata.agent_dispatch_attempted === false,
        'TASK_RESERVATION_NOT_RELEASABLE');
      const journal = await this.rows(connection, 'SELECT state FROM bz_tool_calls WHERE job_id=? AND tool=? AND args_hash=? FOR UPDATE',
        [invocation.jobId, invocation.tool, invocation.argsHash]);
      taskAssert(journal.length === 0, 'TASK_RESERVATION_NOT_RELEASABLE');
      if (input.reason === 'approval_denied') {
        const [approval] = await this.rows(connection, 'SELECT id,job_id,request_id,tool,args_hash,on_behalf_of,status,used_at FROM bz_tool_approvals WHERE id=? FOR UPDATE', [input.approvalId]);
        taskAssert(invocation.approvalRequired && approval && approval.job_id === invocation.jobId && approval.request_id === job.request_id
          && approval.tool === invocation.tool && approval.args_hash === invocation.argsHash && approval.on_behalf_of === job.on_behalf_of
          && approval.status === 'denied' && !approval.used_at, 'TASK_APPROVAL_NOT_READY');
        invocation.approvalId = input.approvalId!;
      }
      if (!invocation.readonly) {
        taskAssert(invocation.budgetState === 'reserved' && task.writeReserved > 0, 'TASK_BUDGET_CONFLICT');
        task.writeReserved--; invocation.budgetState = 'released';
      }
      invocation.outcome = 'confirmed_not_dispatched'; invocation.terminal = true;
      task.ledgerSequence++; task.updatedAt = this.now();
      const result = { schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: invocation.invocationId,
        route: job.metadata.agent_route, tool: invocation.tool, state: input.reason === 'approval_denied' ? 'denied' : 'rejected_before_dispatch',
        ok: false, auto_retry_allowed: false, text: 'The original governed invocation was closed before any dispatch permit was granted.' };
      await connection.query('UPDATE bz_jobs SET result=?,updated_at=? WHERE job_id=?',
        [JSON.stringify(result), sqlDate(task.updatedAt), invocation.jobId]);
      await this.saveInvocation(connection, invocation, task.updatedAt); await this.saveTask(connection, task);
      await this.event(connection, task, 'reservation_released', { invocationId: invocation.invocationId,
        ...(input.actor ? { actor: input.actor } : {}), detail: { reason: input.reason, approval_id: invocation.approvalId } });
      return { fresh: true, invocation, task };
    });
  }
  async grantDispatchPermit(value: GrantAgentTaskPermitInput): Promise<AgentTaskPermitResult> {
    const input = { taskId: taskUuid(value.taskId), sessionId: taskUuid(value.sessionId), invocationId: taskDigest(value.invocationId),
      retryOriginal: value.retryOriginal === true, approvalId: value.approvalId };
    taskAssert(value.retryOriginal === undefined || typeof value.retryOriginal === 'boolean', 'TASK_INVALID_INPUT');
    if (input.approvalId !== undefined) taskInteger(input.approvalId, 1);
    return this.withTask(input.taskId, true, async (connection, task, bindings) => {
      const invocation = await this.invocation(connection, input.sessionId, input.invocationId);
      taskAssert(invocation && invocation.taskId === task.taskId, 'TASK_INVOCATION_CONFLICT');
      const job = await this.validateOriginal(connection, task, invocation, bindings, false);
      await this.bindRun(connection, invocation, false, task.updatedAt);
      if (invocation.permitState === 'held' || invocation.permitState === 'unknown') return { fresh: false, invocation, task };
      taskAssert(!invocation.terminal, 'TASK_INVOCATION_TERMINAL');
      taskAssert(invocation.attempt === 0 || (input.retryOriginal && invocation.outcome === 'confirmed_not_dispatched'), 'TASK_EXPLICIT_RETRY_REQUIRED');
      assertTaskCanDispatch(task, this.now());
      taskAssert(task.activePermits < task.policy.maxConcurrent, 'TASK_CONCURRENCY_EXHAUSTED');
      taskAssert(invocation.readonly || invocation.budgetState === 'reserved', 'TASK_BUDGET_CONFLICT');
      taskAssert(job.metadata.agent_task_id === task.taskId && job.metadata.agent_dispatch_attempted === false, 'TASK_INVOCATION_CONFLICT');
      if (invocation.approvalRequired) {
        taskAssert(input.approvalId !== undefined, 'TASK_APPROVAL_REQUIRED');
        const [approval] = await this.rows(connection, 'SELECT id,job_id,request_id,tool,args_hash,on_behalf_of,status,used_at FROM bz_tool_approvals WHERE id=? FOR UPDATE', [input.approvalId]);
        taskAssert(approval && approval.job_id === invocation.jobId && approval.request_id === job.request_id
          && approval.tool === invocation.tool && approval.args_hash === invocation.argsHash
          && approval.on_behalf_of === job.on_behalf_of && approval.status === 'approved', 'TASK_APPROVAL_NOT_READY');
        if (approval.used_at) {
          taskAssert(invocation.approvalId === input.approvalId && invocation.permitState === 'settled'
            && invocation.outcome === 'confirmed_not_dispatched' && !invocation.terminal && input.retryOriginal,
          'TASK_APPROVAL_NOT_READY');
        } else {
          const [used] = await connection.query("UPDATE bz_tool_approvals SET used_at=? WHERE id=? AND status='approved' AND used_at IS NULL", [sqlDate(this.now()), input.approvalId]);
          taskAssert((used as { affectedRows?: number }).affectedRows === 1, 'TASK_APPROVAL_NOT_READY');
        }
        invocation.approvalId = input.approvalId;
      } else taskAssert(input.approvalId === undefined, 'TASK_APPROVAL_UNEXPECTED');
      invocation.permitId = taskUuid((this.options.newId ?? randomUUID)()); invocation.permitState = 'held';
      invocation.outcome = null; invocation.attempt++; task.activePermits++; task.ledgerSequence++; task.updatedAt = this.now();
      const result = { schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: invocation.invocationId,
        route: job.metadata.agent_route, tool: invocation.tool, state: 'in_progress', ok: false, auto_retry_allowed: false,
        text: 'The original governed invocation has a dispatch permit; its business outcome is not yet confirmed.' };
      await connection.query("UPDATE bz_jobs SET metadata=JSON_SET(metadata,'$.agent_dispatch_attempted',CAST('true' AS JSON),'$.agent_task_permit_id',?,'$.agent_task_permit_attempt',?),result=?,updated_at=? WHERE job_id=?",
        [invocation.permitId, invocation.attempt, JSON.stringify(result), sqlDate(task.updatedAt), invocation.jobId]);
      await this.saveInvocation(connection, invocation, task.updatedAt); await this.saveTask(connection, task);
      await this.event(connection, task, 'dispatch_permitted', { invocationId: invocation.invocationId, permitId: invocation.permitId,
        detail: { approval_id: invocation.approvalId } });
      return { fresh: true, invocation, task };
    });
  }
  async settlePermit(value: SettleAgentTaskPermitInput): Promise<AgentTaskPermitResult> {
    const input = { taskId: taskUuid(value.taskId), sessionId: taskUuid(value.sessionId), invocationId: taskDigest(value.invocationId),
      permitId: taskUuid(value.permitId), outcome: value.outcome, terminal: value.terminal };
    taskAssert(['confirmed_dispatched', 'confirmed_not_dispatched', 'unknown'].includes(input.outcome)
      && typeof input.terminal === 'boolean' && (input.outcome !== 'unknown' || !input.terminal)
      && (input.outcome !== 'confirmed_dispatched' || input.terminal), 'TASK_INVALID_INPUT');
    // Trusted late evidence remains recordable after revocation, expiry, pause or cancellation.
    return this.withTask(input.taskId, false, async (connection, task) => {
      const invocation = await this.invocation(connection, input.sessionId, input.invocationId);
      taskAssert(invocation && invocation.taskId === input.taskId && invocation.permitId === input.permitId, 'TASK_PERMIT_CONFLICT');
      if (invocation.permitState === 'settled') {
        taskAssert(invocation.outcome === input.outcome && invocation.terminal === input.terminal, 'TASK_SETTLEMENT_CONFLICT');
        return { fresh: false, invocation, task };
      }
      if (invocation.permitState === 'unknown' && input.outcome === 'unknown') return { fresh: false, invocation, task };
      taskAssert(invocation.permitState === 'held' || invocation.permitState === 'unknown', 'TASK_PERMIT_CONFLICT');
      const [job] = await this.rows(connection, 'SELECT metadata FROM bz_jobs WHERE job_id=? FOR UPDATE', [invocation.jobId]);
      const metadata = object(job?.metadata);
      taskAssert(metadata.agent_task_id === task.taskId && metadata.agent_task_permit_id === input.permitId, 'TASK_PERMIT_CONFLICT');
      invocation.outcome = input.outcome; invocation.terminal = input.terminal;
      if (input.outcome === 'unknown') invocation.permitState = 'unknown';
      else {
        taskAssert(task.activePermits > 0, 'TASK_RECORD_INVALID'); task.activePermits--;
        invocation.permitState = 'settled';
        if (!invocation.readonly && (input.outcome === 'confirmed_dispatched' || input.terminal)) {
          taskAssert(invocation.budgetState === 'reserved' && task.writeReserved > 0, 'TASK_BUDGET_CONFLICT');
          task.writeReserved--;
          if (input.outcome === 'confirmed_dispatched') { task.writeConsumed++; invocation.budgetState = 'consumed'; }
          else invocation.budgetState = 'released';
        }
        if (input.outcome === 'confirmed_not_dispatched') await connection.query("UPDATE bz_jobs SET metadata=JSON_SET(metadata,'$.agent_dispatch_attempted',CAST('false' AS JSON)),updated_at=? WHERE job_id=?",
          [sqlDate(this.now()), invocation.jobId]);
      }
      task.ledgerSequence++; task.updatedAt = this.now();
      await this.saveInvocation(connection, invocation, task.updatedAt); await this.saveTask(connection, task);
      await this.event(connection, task, `settled_${input.outcome}`, { invocationId: invocation.invocationId, permitId: input.permitId, detail: { terminal: input.terminal } });
      return { fresh: true, invocation, task };
    });
  }
}
