import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { AgentTaskControlError, type AgentTaskPolicy, type ReserveAgentTaskInvocationInput } from '../../core/runtime/agent-task-control';
import { AgentTaskControlRepository } from './config-agent-task-control-repository';
import { openTaskMysqlFixture, seedTaskMysqlInvocation, seedTaskMysqlMembers, taskMysqlConfigPath } from '../../test-support/agent-task-control-mysql-fixture';
import { admitAgentTaskTurnFor, agentTaskCapabilitiesFor, assertAgentLegacyTaskAllowedFor } from '../../app/agent-task-control';
import { taskRuntimeFor } from '../../app/agent-task-runtime';
import type { ConfigStoreContract } from './configstore';
import type { AgentToolAuthContext } from '../../app/agent-tool-invocations';
import type { RuntimeStateStore } from '../../core/state/state-contracts';
import type { Job } from '../../core/contracts/types';

const coordinates = ({ taskId, sessionId, invocationId }: ReserveAgentTaskInvocationInput) => ({ taskId, sessionId, invocationId });
const code = (expected: string) => (error: unknown) => error instanceof AgentTaskControlError && error.code === expected;
const journal = { scope: 'products:write', idempotencyKey: 'e'.repeat(64) };

test('partial task storage cannot downgrade an enrolled Session through capabilities, turn admission or legacy runtime', async () => {
  const tables = ['bz_agent_tasks', 'bz_agent_task_members', 'bz_agent_task_enforcements',
    'bz_agent_task_invocations', 'bz_agent_task_runs', 'bz_agent_task_events'];
  const sessionId = randomUUID();
  const auth = { session: { session_id: sessionId }, client: { app_id: 'example-agent' } } as AgentToolAuthContext;
  for (const missing of tables) {
    const repo = new AgentTaskControlRepository(() => ({ query: async (sql: string) => {
      assert.match(sql, /information_schema\.TABLES/, 'Partial storage must stop before accessing task or business records.');
      return [tables.filter((name) => name !== missing).map((name) => ({ table_name: name }))];
    } }) as unknown as Pool);
    const store = { agentTaskControl: repo, agentClientRuntime: {} } as unknown as ConfigStoreContract;
    for (const wired of [false, true]) {
      await assert.rejects(agentTaskCapabilitiesFor(store, auth, wired), code('TASK_UNAVAILABLE'), missing);
    }
    await assert.rejects(admitAgentTaskTurnFor(store, auth, 'shop', 'synthetic-conversation', undefined), code('TASK_UNAVAILABLE'), missing);
    await assert.rejects(assertAgentLegacyTaskAllowedFor(store, sessionId), code('TASK_UNAVAILABLE'), missing);
    await assert.rejects(taskRuntimeFor(store, {} as RuntimeStateStore,
      { agent_session_id: sessionId, metadata: {} } as Job), code('TASK_UNAVAILABLE'), missing);
  }
  const repo = new AgentTaskControlRepository(() => ({ query: async () => [[]] }) as unknown as Pool);
  const oldStore = { agentTaskControl: repo, agentClientRuntime: {} } as unknown as ConfigStoreContract;
  const oldCapabilities = await agentTaskCapabilitiesFor(oldStore, auth, true);
  assert.equal(oldCapabilities.supported, false);
  assert.equal(oldCapabilities.mode, 'optional', 'Only a wholly unmigrated store retains the legacy optional path.');
  await assertAgentLegacyTaskAllowedFor(oldStore, sessionId);
});

test('task integration persists atomic journals and precise runtime admission in MySQL', { skip: !taskMysqlConfigPath }, async (t) => {
  const pool = await openTaskMysqlFixture();
  try {
    const setup = async (policy: Partial<AgentTaskPolicy> = {}) => {
      const repo = new AgentTaskControlRepository(() => pool);
      const members = await seedTaskMysqlMembers(pool);
      const create = { taskId: randomUUID(), requestId: randomUUID(), actor: 'example-administrator',
        members: members.map(({ sessionId, clientAppId, route, clientConversationId }) => ({ sessionId, clientAppId, route, clientConversationId,
          allowedTools: ['product_update', 'inventory_read'] })),
        policy: { maxWriteCalls: 4, maxConcurrent: 2, expiresAt: null, ...policy } };
      const task = await repo.createAdminTask(create);
      const reserve = async (index = 0, options: Parameters<typeof seedTaskMysqlInvocation>[2] = {}) => {
        const input = { taskId: task.taskId, ...await seedTaskMysqlInvocation(pool, members[index]!, options) };
        await repo.reserveInvocation(input);
        return input;
      };
      return { repo, members, create, task, reserve };
    };
    const row = async (sql: string, values: unknown[]) => {
      const [rows]: any = await pool.query(sql, values); return rows[0];
    };
    const json = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;
    const getJournal = (input: ReserveAgentTaskInvocationInput) => row('SELECT * FROM bz_tool_calls WHERE job_id=? AND tool=? AND args_hash=?', [input.jobId, input.tool, input.argsHash]);
    const metadata = async (jobId: string) => json((await row('SELECT metadata FROM bz_jobs WHERE job_id=?', [jobId])).metadata);
    const approval = async (input: ReserveAgentTaskInvocationInput) => {
      const [result]: any = await pool.query(`INSERT INTO bz_tool_approvals (job_id,request_id,provider,tool,scope,risk,args_hash,status,on_behalf_of,created_at)
        SELECT job_id,request_id,?,?,?,?,?,'approved',on_behalf_of,NOW() FROM bz_jobs WHERE job_id=?`,
      ['example-provider', input.tool, journal.scope, 'high', input.argsHash, input.jobId]);
      return Number(result.insertId);
    };

    await t.test('capabilities require every task table and preserve operational database errors', async () => {
      const repo = new AgentTaskControlRepository(() => pool);
      assert.equal(await repo.supportsTaskControl(), true);
      const offline = new Error('synthetic_database_unavailable');
      const unavailable = new AgentTaskControlRepository(() => ({ query: async () => { throw offline; } }) as unknown as Pool);
      await assert.rejects(unavailable.supportsTaskControl(), (error) => error === offline);
      const missing = new AgentTaskControlRepository(() => ({ query: async () => [[{ table_name: 'bz_agent_tasks' }]] }) as unknown as Pool);
      await assert.rejects(missing.supportsTaskControl(), code('TASK_UNAVAILABLE'));
      const unmigrated = new AgentTaskControlRepository(() => ({ query: async () => [[]] }) as unknown as Pool);
      assert.equal(await unmigrated.supportsTaskControl(), false);
    });

    await t.test('an unrelated caller cannot trigger whole-task blocking, but an original member revalidates all members', async () => {
      const fx = await setup();
      await pool.query('UPDATE bz_agent_sessions SET revoked_at=NOW() WHERE session_id=?', [fx.members[1]!.sessionId]);
      const { runId: _run, principal: _principal, subject: _subject, ...member } = fx.members[0]!;
      await assert.rejects(fx.repo.validateMember(fx.task.taskId, { ...member, sessionId: randomUUID() }), code('TASK_MEMBER_MISMATCH'));
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.state, 'active');
      await assert.rejects(fx.repo.validateMember(fx.task.taskId, member, fx.task.scopeHash), code('TASK_SCOPE_BLOCKED'));
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.state, 'blocked');
    });

    await t.test('a preparing real run binds once to its exact task and retains that link when ended', async () => {
      const fx = await setup();
      const member = fx.members[0]!;
      await pool.query("UPDATE bz_agent_client_runs SET status='preparing' WHERE run_id=?", [member.runId]);
      await fx.repo.bindRuntimeRun(fx.task.taskId, fx.task.scopeHash, member.sessionId, member.runId);
      assert.equal((await fx.repo.findTaskForRun(member.runId, member.sessionId))!.taskId, fx.task.taskId);
      assert.equal(await fx.repo.findTaskForRun(member.runId, fx.members[1]!.sessionId), null);
      const other = await fx.repo.createAdminTask({ ...fx.create, taskId: randomUUID(), requestId: randomUUID() });
      await assert.rejects(fx.repo.bindRuntimeRun(other.taskId, other.scopeHash, member.sessionId, member.runId), code('TASK_RUN_TASK_CONFLICT'));
      await pool.query("UPDATE bz_agent_client_runs SET status='completed',completed_at=NOW() WHERE run_id=?", [member.runId]);
      await assert.rejects(fx.repo.bindRuntimeRun(fx.task.taskId, fx.task.scopeHash, member.sessionId, member.runId), code('TASK_RUN_INACTIVE'));
      assert.equal((await fx.repo.findTaskForRun(member.runId, member.sessionId))!.taskId, fx.task.taskId);
    });

    await t.test('sticky enrollment rejects legacy dispatch and persists through cancel', async () => {
      const members = await seedTaskMysqlMembers(pool);
      const repo = new AgentTaskControlRepository(() => pool);
      await repo.assertUnmanagedDispatch(members[0]!.sessionId);
      const task = await repo.createAdminTask({ taskId: randomUUID(), requestId: randomUUID(), actor: 'example-administrator',
        members: members.map(({ runId: _r, principal: _p, subject: _s, ...m }) => ({ ...m, allowedTools: ['product_update'] })),
        policy: { maxWriteCalls: 1, maxConcurrent: 1, expiresAt: null } });
      await assert.rejects(repo.assertUnmanagedDispatch(members[0]!.sessionId), code('TASK_REQUIRED'));
      await repo.controlTask({ taskId: task.taskId, requestId: randomUUID(), actor: 'example-administrator', expectedRevision: task.revision, action: 'cancel' });
      await assert.rejects(repo.assertUnmanagedDispatch(members[0]!.sessionId), code('TASK_REQUIRED'));
    });

    await t.test('bounded cursor pages are stable and invocation lookup stays in the original Session', async () => {
      const fx = await setup();
      const inputs = await Promise.all([fx.reserve(), fx.reserve(1), fx.reserve()]);
      const first = await fx.repo.listInvocations(fx.task.taskId, { limit: 2 });
      const second = await fx.repo.listInvocations(fx.task.taskId, { limit: 2, before: first.nextCursor! });
      assert.equal(first.items.length, 2); assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null);
      assert.deepEqual([...first.items, ...second.items].map((item) => item.jobId), inputs.map((item) => item.jobId).sort().reverse());
      assert.equal(await fx.repo.findInvocation(fx.members[1]!.sessionId, inputs[0]!.invocationId), null);
      assert.equal((await fx.repo.findInvocation(inputs[0]!.sessionId, inputs[0]!.invocationId))!.taskId, fx.task.taskId);
      const tasks = await fx.repo.listTasks({ limit: 2 });
      assert.equal(tasks.items.length, 2); assert.equal(tasks.nextCursor, tasks.items[1]!.taskId);
      const later = await fx.repo.listTasks({ limit: 2, before: tasks.nextCursor! });
      assert.ok(later.items.every((task) => task.taskId < tasks.nextCursor!));
      await assert.rejects(fx.repo.listTasks({ limit: 101 }), code('TASK_INVALID_INPUT'));
      await assert.rejects(fx.repo.listInvocations(fx.task.taskId, { before: 'not-a-cursor' }), code('TASK_INVALID_INPUT'));
    });

    await t.test('one concurrent grant owns the approval, journal, permit and original attempt fence', async () => {
      const fx = await setup();
      const input = await fx.reserve(0, { approvalRequired: true });
      const approvalId = await approval(input);
      const results = await Promise.all([1, 2].map(() => fx.repo.grantDispatchPermit({ ...coordinates(input), approvalId, journal })));
      assert.equal(results.filter((item) => item.fresh).length, 1);
      assert.equal(new Set(results.map((item) => item.invocation.permitId)).size, 1);
      assert.equal((await getJournal(input)).state, 'dispatching');
      assert.ok((await row('SELECT used_at FROM bz_tool_approvals WHERE id=?', [approvalId])).used_at);
      const stored = await metadata(input.jobId);
      assert.equal(stored.agent_dispatch_attempted, true);
      assert.equal(stored.agent_task_journal.permit_id, results[0]!.invocation.permitId);
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.activePermits, 1);
      await assert.rejects(fx.repo.grantDispatchPermit({ ...coordinates(input), approvalId }), code('TASK_JOURNAL_CONFLICT'));
    });

    await t.test('concurrent contract preparation and a delayed old instance preserve the real permit JSON and dispatch fence', async () => {
      const fx = await setup();
      const input = { taskId: fx.task.taskId, ...await seedTaskMysqlInvocation(pool, fx.members[0]!) };
      const contract = (await metadata(input.jobId)).agent_task_tool_contract;
      await pool.query("UPDATE bz_jobs SET metadata=JSON_SET(JSON_REMOVE(metadata,'$.agent_task_tool_contract'),'$.synthetic_unrelated',?) WHERE job_id=?",
        ['preserve-me', input.jobId]);
      await Promise.all([fx.repo.freezeInvocationContract(input.jobId, contract), fx.repo.freezeInvocationContract(input.jobId, contract)]);
      assert.deepEqual((await metadata(input.jobId)).agent_task_tool_contract, contract);
      assert.equal((await metadata(input.jobId)).synthetic_unrelated, 'preserve-me');
      await fx.repo.reserveInvocation(input);

      let entered!: () => void;
      let release!: () => void;
      const beforeRead = new Promise<void>((resolve) => { entered = resolve; });
      const continueRead = new Promise<void>((resolve) => { release = resolve; });
      const delayedPool = new Proxy(pool, { get(target, property) {
        if (property === 'getConnection') return async () => {
          const connection = await target.getConnection();
          return new Proxy(connection, { get(conn, key) {
            if (key === 'query') return async (sql: string, values: unknown[]) => {
              if (sql === 'SELECT metadata FROM bz_jobs WHERE job_id=? FOR UPDATE') { entered(); await continueRead; }
              return conn.query(sql, values);
            };
            const value = Reflect.get(conn, key); return typeof value === 'function' ? value.bind(conn) : value;
          } });
        };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const delayed = new AgentTaskControlRepository(() => delayedPool).freezeInvocationContract(input.jobId, contract);
      await beforeRead;
      let permit;
      try { permit = await fx.repo.grantDispatchPermit({ ...coordinates(input), journal }); }
      finally { release(); }
      await delayed;
      const stored = await metadata(input.jobId);
      assert.equal(stored.agent_task_id, fx.task.taskId);
      assert.equal(stored.agent_task_permit_id, permit.invocation.permitId);
      assert.equal(stored.agent_task_permit_attempt, 1);
      assert.equal(stored.agent_task_journal.permit_id, permit.invocation.permitId);
      assert.equal(stored.agent_dispatch_attempted, true);
      assert.equal(stored.synthetic_unrelated, 'preserve-me');
      assert.equal((await getJournal(input)).state, 'dispatching');
      assert.equal((await fx.repo.findInvocation(input.sessionId, input.invocationId))!.attempt, 1);
      await assert.rejects(fx.repo.freezeInvocationContract(input.jobId, { ...contract, readonly: true }), code('TASK_INVOCATION_CONFLICT'));
      assert.deepEqual(await metadata(input.jobId), stored, 'A conflicting delayed contract cannot replace any original permit fields.');
      assert.equal((await fx.repo.grantDispatchPermit({ ...coordinates(input), journal })).fresh, false);
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.activePermits, 1);
    });

    await t.test('a fault after journal insertion rolls back approval, journal, permit and Job together', async () => {
      const fx = await setup();
      const input = await fx.reserve(0, { approvalRequired: true });
      const approvalId = await approval(input);
      const faultPool = new Proxy(pool, { get(target, property) {
        if (property === 'getConnection') return async () => {
          const connection = await target.getConnection();
          return new Proxy(connection, { get(conn, key) {
            if (key === 'query') return async (sql: string, values: unknown[]) => {
              if (sql.startsWith('INSERT INTO bz_agent_task_events')) throw new Error('synthetic_transaction_fault');
              return conn.query(sql, values);
            };
            const value = Reflect.get(conn, key); return typeof value === 'function' ? value.bind(conn) : value;
          } });
        };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await assert.rejects(new AgentTaskControlRepository(() => faultPool).grantDispatchPermit({ ...coordinates(input), approvalId, journal }), /synthetic_transaction_fault/);
      assert.equal(await getJournal(input), undefined);
      assert.equal((await row('SELECT used_at FROM bz_tool_approvals WHERE id=?', [approvalId])).used_at, null);
      assert.equal((await metadata(input.jobId)).agent_dispatch_attempted, false);
      assert.equal((await fx.repo.findInvocation(input.sessionId, input.invocationId))!.permitId, null);
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.activePermits, 0);
    });

    await t.test('a preexisting journal never consumes a new approval or obtains a second permit', async () => {
      const fx = await setup();
      const input = await fx.reserve(0, { approvalRequired: true });
      const approvalId = await approval(input);
      await pool.query(`INSERT INTO bz_tool_calls (job_id,tool,scope,args_hash,state,idempotency_key,ok,status,created_at)
        VALUES (?,?,?,?,'uncertain',?,0,0,NOW())`, [input.jobId, input.tool, journal.scope, input.argsHash, journal.idempotencyKey]);
      const result = await fx.repo.grantDispatchPermit({ ...coordinates(input), approvalId, journal });
      assert.equal(result.fresh, false); assert.equal(result.invocation.permitId, null);
      assert.equal(result.task.activePermits, 0);
      assert.equal((await row('SELECT used_at FROM bz_tool_approvals WHERE id=?', [approvalId])).used_at, null);
      assert.equal((await metadata(input.jobId)).agent_dispatch_attempted, false);
    });

    await t.test('unknown retains occupancy, a late original response settles once even after cancel, and conflicting responses are rejected', async () => {
      const fx = await setup();
      const input = await fx.reserve();
      const granted = await fx.repo.grantDispatchPermit({ ...coordinates(input), journal });
      const settle = { ...coordinates(input), permitId: granted.invocation.permitId! };
      const unknown = await fx.repo.settlePermit({ ...settle, outcome: 'unknown', terminal: false });
      assert.equal((await getJournal(input)).state, 'uncertain');
      assert.equal(unknown.task.activePermits, 1); assert.equal(unknown.task.writeReserved, 1);
      await assert.rejects(fx.repo.settlePermit({ ...settle, outcome: 'confirmed_not_dispatched', terminal: false }), code('TASK_JOURNAL_CONFLICT'));
      await fx.repo.controlTask({ taskId: fx.task.taskId, actor: 'example-administrator', requestId: randomUUID(), expectedRevision: fx.task.revision, action: 'cancel' });
      const reopened = new AgentTaskControlRepository(() => pool);
      const response = { ok: true, status: 200, text: '{"updated":true}' };
      const complete = { ...settle, outcome: 'confirmed_dispatched' as const, terminal: true, response };
      const done = await reopened.settlePermit(complete);
      assert.equal(done.task.state, 'cancelled'); assert.equal(done.task.writeReserved, 0); assert.equal(done.task.writeConsumed, 1);
      assert.equal(done.task.activePermits, 0); assert.equal((await getJournal(input)).state, 'completed');
      assert.equal(json((await getJournal(input)).result_json).text, response.text);
      assert.equal((await reopened.settlePermit(complete)).fresh, false);
      await assert.rejects(reopened.settlePermit({ ...complete, response: { ...response, text: 'different' } }), code('TASK_SETTLEMENT_CONFLICT'));
    });

    await t.test('confirmed non-dispatch removes only its empty reservation and explicit retry retains original approval', async () => {
      const fx = await setup();
      const input = await fx.reserve(0, { approvalRequired: true });
      const approvalId = await approval(input);
      const granted = await fx.repo.grantDispatchPermit({ ...coordinates(input), approvalId, journal });
      await fx.repo.settlePermit({ ...coordinates(input), permitId: granted.invocation.permitId!, outcome: 'confirmed_not_dispatched', terminal: false });
      assert.equal(await getJournal(input), undefined);
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.writeReserved, 1);
      const retried = await fx.repo.grantDispatchPermit({ ...coordinates(input), approvalId, journal, retryOriginal: true });
      assert.equal(retried.fresh, true); assert.notEqual(retried.invocation.permitId, granted.invocation.permitId);
      assert.equal(retried.invocation.approvalId, approvalId); assert.equal(retried.invocation.attempt, 2);
      await assert.rejects(fx.repo.settlePermit({ ...coordinates(input), permitId: granted.invocation.permitId!, outcome: 'unknown', terminal: false }), code('TASK_PERMIT_CONFLICT'));
      assert.equal((await getJournal(input)).state, 'dispatching');
    });

    await t.test('read calls are journaled and degraded response evidence still settles transport occupancy', async () => {
      const fx = await setup({ maxWriteCalls: 0 });
      const input = await fx.reserve(0, { tool: 'inventory_read', readonly: true, extraMetadata: { agent_frozen_arguments: 'synthetic-ciphertext' } });
      const granted = await fx.repo.grantDispatchPermit({ ...coordinates(input), journal });
      const done = await fx.repo.settlePermit({ ...coordinates(input), permitId: granted.invocation.permitId!,
        outcome: 'confirmed_dispatched', terminal: true, response: { ok: false, status: 503, text: 'synthetic unavailable' }, evidenceDegraded: true });
      assert.equal(done.task.writeConsumed, 0); assert.equal(done.task.activePermits, 0);
      assert.equal((await getJournal(input)).state, 'evidence_degraded');
      await fx.repo.clearFrozenArguments(input.jobId);
      const saved = await metadata(input.jobId);
      assert.equal(saved.agent_frozen_arguments, undefined);
      assert.equal(saved.agent_task_id, fx.task.taskId); assert.equal(saved.agent_task_journal.permit_id, granted.invocation.permitId);
    });

    await t.test('a committed grant with a lost acknowledgement reopens without dispatching again', async () => {
      const fx = await setup();
      const input = await fx.reserve();
      const lostAckPool = new Proxy(pool, { get(target, property) {
        if (property === 'getConnection') return async () => {
          const connection = await target.getConnection();
          return new Proxy(connection, { get(conn, key) {
            if (key === 'commit') return async () => { await conn.commit(); throw new Error('synthetic_commit_ack_lost'); };
            const value = Reflect.get(conn, key); return typeof value === 'function' ? value.bind(conn) : value;
          } });
        };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await assert.rejects(new AgentTaskControlRepository(() => lostAckPool).grantDispatchPermit({ ...coordinates(input), journal }), /synthetic_commit_ack_lost/);
      const retry = await new AgentTaskControlRepository(() => pool).grantDispatchPermit({ ...coordinates(input), journal });
      assert.equal(retry.fresh, false); assert.equal(retry.invocation.attempt, 1);
      assert.equal(retry.task.activePermits, 1); assert.equal(retry.task.writeReserved, 1);
      assert.equal((await getJournal(input)).state, 'dispatching');
    });
  } finally { await pool.end(); }
});
