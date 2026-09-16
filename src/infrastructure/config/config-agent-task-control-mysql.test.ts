import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { AgentTaskControlError, type AgentTaskPolicy, type ReserveAgentTaskInvocationInput } from '../../core/runtime/agent-task-control';
import { AgentTaskControlRepository } from './config-agent-task-control-repository';
import { openTaskMysqlFixture, seedTaskMysqlInvocation, seedTaskMysqlMembers, taskMysqlConfigPath } from '../../test-support/agent-task-control-mysql-fixture';

const coordinates = ({ taskId, sessionId, invocationId }: ReserveAgentTaskInvocationInput) => ({ taskId, sessionId, invocationId });
const code = (expected: string) => (error: unknown) => error instanceof AgentTaskControlError && error.code === expected;

test('task foundation uses real MySQL transactions and durable original identities', { skip: !taskMysqlConfigPath }, async (t) => {
  const pool = await openTaskMysqlFixture();
  try {
    const setup = async (policy: Partial<AgentTaskPolicy> = {}) => {
      const repo = new AgentTaskControlRepository(() => pool);
      const members = await seedTaskMysqlMembers(pool);
      const create = { taskId: randomUUID(), requestId: randomUUID(), actor: 'example-administrator',
        members: members.map(({ sessionId, clientAppId, route, clientConversationId }) => ({ sessionId, clientAppId, route, clientConversationId,
          allowedTools: ['product_update', 'inventory_read'] })),
        policy: { maxWriteCalls: 2, maxConcurrent: 1, expiresAt: null, ...policy } };
      const task = await repo.createAdminTask(create);
      const reserve = async (index: number, options: Parameters<typeof seedTaskMysqlInvocation>[2] = {}) => {
        const input: ReserveAgentTaskInvocationInput = { taskId: task.taskId, ...await seedTaskMysqlInvocation(pool, members[index]!, options) };
        return { input, value: await repo.reserveInvocation(input) };
      };
      return { repo, members, create, task, reserve };
    };
    const jobMetadata = async (jobId: string) => {
      const [rows]: any = await pool.query('SELECT metadata FROM bz_jobs WHERE job_id=?', [jobId]);
      return typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
    };
    const approval = async (input: ReserveAgentTaskInvocationInput, status = 'approved') => {
      const [row]: any = await pool.query('INSERT INTO bz_tool_approvals (job_id,request_id,provider,tool,scope,risk,args_hash,status,on_behalf_of,created_at) SELECT job_id,request_id,?,?,?,?,?,?,on_behalf_of,NOW() FROM bz_jobs WHERE job_id=?',
        ['example-provider', input.tool, 'products:write', 'high', input.argsHash, status, input.jobId]);
      return Number(row.insertId);
    };

    await t.test('concurrent writers compete for the same last task budget across members', async () => {
      const fx = await setup({ maxWriteCalls: 1 });
      const inputs = await Promise.all(fx.members.map(async (member) => ({ taskId: fx.task.taskId, ...await seedTaskMysqlInvocation(pool, member) })));
      const outcomes = await Promise.allSettled(inputs.map((input) => fx.repo.reserveInvocation(input)));
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
      const failed = outcomes.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      assert.equal(failed.reason.code, 'TASK_WRITE_BUDGET_EXHAUSTED');
      const task = await fx.repo.getTask(fx.task.taskId);
      assert.equal(task!.writeReserved, 1);
      assert.equal(task!.writeConsumed, 0);
      assert.equal(task!.activePermits, 0);
      const index = outcomes.findIndex((r) => r.status === 'fulfilled');
      const restored = new AgentTaskControlRepository(() => pool);
      await restored.reserveInvocation(inputs[index]!);
      assert.equal((await restored.getTask(task!.taskId))!.writeReserved, 1, 'Original ID is not charged twice after rebuilding the repository');
      assert.ok(await restored.getEnforcement(fx.members[index]!.sessionId));
    });

    await t.test('read tools consume no write budget but share the execution concurrency limit', async () => {
      const fx = await setup({ maxWriteCalls: 0 });
      const first = await fx.reserve(0, { tool: 'inventory_read', readonly: true });
      const second = await fx.reserve(1, { tool: 'inventory_read', readonly: true });
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.writeReserved, 0);
      const outcomes = await Promise.allSettled([first, second].map(({ input }) => fx.repo.grantDispatchPermit(coordinates(input))));
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal((outcomes.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'TASK_CONCURRENCY_EXHAUSTED');
      const winner = outcomes.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof fx.repo.grantDispatchPermit>>>;
      assert.equal(winner.value.invocation.budgetState, null);
      assert.equal(winner.value.task.activePermits, 1);
      assert.equal(winner.value.fresh, true);
    });

    await t.test('unknown outcomes retain occupancy across reopen and settle only the original permit', async () => {
      const fx = await setup();
      const { input } = await fx.reserve(0);
      const permit = await fx.repo.grantDispatchPermit(coordinates(input));
      assert.equal((await jobMetadata(input.jobId)).agent_dispatch_attempted, true);
      const unknown = await fx.repo.settlePermit({ ...coordinates(input), permitId: permit.invocation.permitId!, outcome: 'unknown', terminal: false });
      assert.equal(unknown.task.activePermits, 1);
      assert.equal(unknown.task.writeReserved + unknown.task.writeConsumed, 1);
      const restored = new AgentTaskControlRepository(() => pool);
      const retry = await restored.grantDispatchPermit(coordinates(input));
      assert.equal(retry.fresh, false, 'An unknown permit must never authorize another HTTP request');
      assert.equal(retry.invocation.permitId, permit.invocation.permitId);
      const done = await restored.settlePermit({ ...coordinates(input), permitId: permit.invocation.permitId!, outcome: 'confirmed_dispatched', terminal: true });
      assert.equal(done.task.activePermits, 0);
      assert.equal(done.task.writeReserved, 0);
      assert.equal(done.task.writeConsumed, 1);
      const repeated = await restored.settlePermit({ ...coordinates(input), permitId: permit.invocation.permitId!, outcome: 'confirmed_dispatched', terminal: true });
      assert.equal(repeated.fresh, false);
      assert.equal(repeated.task.writeConsumed, 1);
    });

    await t.test('pause rejects new permits, allows old receipts, and cancel keeps enforcement sticky', async () => {
      const fx = await setup();
      const first = await fx.reserve(0);
      const second = await fx.reserve(1);
      const permit = await fx.repo.grantDispatchPermit(coordinates(first.input));
      const paused = await fx.repo.controlTask({ taskId: fx.task.taskId, expectedRevision: fx.task.revision, requestId: randomUUID(), actor: 'example-administrator', action: 'pause' });
      await assert.rejects(fx.repo.grantDispatchPermit(coordinates(second.input)), code('TASK_PAUSED'));
      const final = await fx.repo.settlePermit({ ...coordinates(first.input), permitId: permit.invocation.permitId!, outcome: 'confirmed_dispatched', terminal: true });
      assert.equal(final.task.state, 'paused');
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.state, 'paused');
      await assert.rejects(fx.repo.controlTask({ taskId: fx.task.taskId, expectedRevision: fx.task.revision, requestId: randomUUID(), actor: 'example-administrator', action: 'resume' }), code('TASK_REVISION_CONFLICT'));
      const cancelled = await fx.repo.controlTask({ taskId: fx.task.taskId, expectedRevision: paused.revision, requestId: randomUUID(), actor: 'example-administrator', action: 'cancel' });
      await assert.rejects(fx.repo.controlTask({ taskId: fx.task.taskId, expectedRevision: cancelled.revision, requestId: randomUUID(), actor: 'example-administrator', action: 'resume' }), code('TASK_CANCELLED'));
      for (const member of fx.members) assert.ok(await fx.repo.getEnforcement(member.sessionId));
    });

    await t.test('pending approvals retain reserved budget without consuming approval or a permit', async () => {
      const fx = await setup();
      const { input } = await fx.reserve(0, { approvalRequired: true });
      const approvalId = await approval(input, 'pending');
      await assert.rejects(fx.repo.grantDispatchPermit({ ...coordinates(input), approvalId }), code('TASK_APPROVAL_NOT_READY'));
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.activePermits, 0);
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.writeReserved, 1);
      assert.equal((await jobMetadata(input.jobId)).agent_dispatch_attempted, false);
      await pool.query("UPDATE bz_tool_approvals SET status='approved' WHERE id=?", [approvalId]);
      const paused = await fx.repo.controlTask({ taskId: fx.task.taskId, expectedRevision: 1, requestId: randomUUID(), actor: 'example-administrator', action: 'pause' });
      await assert.rejects(fx.repo.grantDispatchPermit({ ...coordinates(input), approvalId }), code('TASK_PAUSED'));
      const [rows]: any = await pool.query('SELECT used_at FROM bz_tool_approvals WHERE id=?', [approvalId]);
      assert.equal(rows[0].used_at, null);
      await fx.repo.controlTask({ taskId: fx.task.taskId, expectedRevision: paused.revision, requestId: randomUUID(), actor: 'example-administrator', action: 'resume' });
      assert.equal((await fx.repo.grantDispatchPermit({ ...coordinates(input), approvalId })).fresh, true);
    });

    await t.test('a failure writing the Job fence rolls back approval consumption and the task permit together', async () => {
      const fx = await setup();
      const { input } = await fx.reserve(0, { approvalRequired: true });
      const approvalId = await approval(input);
      let failedAfterApproval = false;
      const wrappedPool = new Proxy(pool, { get(target, key) {
        if (key !== 'getConnection') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
        return async () => {
          const connection = await target.getConnection();
          return new Proxy(connection, { get(conn, prop) {
            if (prop === 'query') return async (sql: string, ...args: any[]) => {
              if (/UPDATE\s+`?bz_jobs`?/i.test(sql)) { failedAfterApproval = true; throw new Error('synthetic_transaction_failure'); }
              return (conn.query as any)(sql, ...args);
            };
            const value = Reflect.get(conn, prop); return typeof value === 'function' ? value.bind(conn) : value;
          } });
        };
      } }) as Pool;
      const failing = new AgentTaskControlRepository(() => wrappedPool);
      await assert.rejects(failing.grantDispatchPermit({ ...coordinates(input), approvalId }));
      assert.equal(failedAfterApproval, true);
      const [rows]: any = await pool.query('SELECT used_at FROM bz_tool_approvals WHERE id=?', [approvalId]);
      assert.equal(rows[0].used_at, null);
      assert.equal((await jobMetadata(input.jobId)).agent_dispatch_attempted, false);
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.activePermits, 0);
      const granted = await fx.repo.grantDispatchPermit({ ...coordinates(input), approvalId });
      assert.equal(granted.fresh, true);
      assert.equal(granted.task.activePermits, 1);
    });

    await t.test('revocation of an uncalled original member blocks the entire task', async () => {
      const fx = await setup();
      const { input } = await fx.reserve(0);
      await pool.query('UPDATE bz_agent_sessions SET revoked_at=NOW() WHERE session_id=?', [fx.members[1]!.sessionId]);
      await assert.rejects(fx.repo.grantDispatchPermit(coordinates(input)), code('TASK_SCOPE_BLOCKED'));
      assert.equal((await jobMetadata(input.jobId)).agent_dispatch_attempted, false);
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.activePermits, 0);
    });

    await t.test('missing/ended runs and mutable classification cannot create a new controlled invocation', async () => {
      const fx = await setup();
      const missing = { taskId: fx.task.taskId, ...await seedTaskMysqlInvocation(pool, fx.members[0]!, { runId: randomUUID() }) };
      await assert.rejects(fx.repo.reserveInvocation(missing), code('TASK_RUN_CONFLICT'));
      const changed = { taskId: fx.task.taskId, ...await seedTaskMysqlInvocation(pool, fx.members[0]!) };
      await assert.rejects(fx.repo.reserveInvocation({ ...changed, readonly: true }), code('TASK_INVOCATION_CONFLICT'));
      await pool.query("UPDATE bz_agent_client_runs SET status='completed',completed_at=NOW() WHERE run_id=?", [fx.members[0]!.runId]);
      await assert.rejects(fx.repo.reserveInvocation(changed), code('TASK_RUN_INACTIVE'));
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.writeReserved, 0);
    });

    await t.test('a real run cannot move to a second approved task by using another invocation ID', async () => {
      const fx = await setup();
      await fx.reserve(0);
      const secondTask = await fx.repo.createAdminTask({ ...fx.create, taskId: randomUUID(), requestId: randomUUID() });
      const attempt = { taskId: secondTask.taskId, ...await seedTaskMysqlInvocation(pool, fx.members[0]!) };
      await assert.rejects(fx.repo.reserveInvocation(attempt), code('TASK_RUN_TASK_CONFLICT'));
      assert.equal((await fx.repo.getTask(secondTask.taskId))!.writeReserved, 0);
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.writeReserved, 1);
    });

    await t.test('confirmed no-dispatch retries use a new permit but reject late settlement from the old permit', async () => {
      const fx = await setup();
      const { input } = await fx.reserve(0);
      const first = await fx.repo.grantDispatchPermit(coordinates(input));
      await fx.repo.settlePermit({ ...coordinates(input), permitId: first.invocation.permitId!, outcome: 'confirmed_not_dispatched', terminal: false });
      await assert.rejects(fx.repo.grantDispatchPermit(coordinates(input)), code('TASK_EXPLICIT_RETRY_REQUIRED'));
      const second = await fx.repo.grantDispatchPermit({ ...coordinates(input), retryOriginal: true });
      assert.notEqual(second.invocation.permitId, first.invocation.permitId);
      assert.equal(second.invocation.attempt, 2);
      assert.equal(second.task.writeReserved, 1);
      await assert.rejects(fx.repo.settlePermit({ ...coordinates(input), permitId: first.invocation.permitId!, outcome: 'confirmed_dispatched', terminal: true }), code('TASK_PERMIT_CONFLICT'));
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.activePermits, 1);
      const final = await fx.repo.settlePermit({ ...coordinates(input), permitId: second.invocation.permitId!, outcome: 'confirmed_not_dispatched', terminal: true });
      assert.equal(final.task.writeReserved, 0);
      assert.equal(final.task.writeConsumed, 0);
      assert.equal(final.task.activePermits, 0);
      await assert.rejects(fx.repo.grantDispatchPermit({ ...coordinates(input), retryOriginal: true }), code('TASK_INVOCATION_TERMINAL'));
    });

    await t.test('disabling Agent Runtime for one member blocks another member before its Job fence', async () => {
      const fx = await setup();
      const { input } = await fx.reserve(0);
      await pool.query('UPDATE bz_routes SET agent_client=? WHERE route_key=?', [JSON.stringify({ enabled: false }), fx.members[1]!.route]);
      await assert.rejects(fx.repo.grantDispatchPermit(coordinates(input)), code('TASK_SCOPE_BLOCKED'));
      assert.equal((await jobMetadata(input.jobId)).agent_dispatch_attempted, false);
    });

    await t.test('a temporary connection failure can retry the same original reservation without resetting its task', async () => {
      const fx = await setup();
      const { input } = await fx.reserve(0);
      const failingPool = new Proxy(pool, { get(target, prop) {
        if (prop === 'getConnection') return async () => { throw Object.assign(new Error('synthetic_connection_failure'), { code: 'ECONNRESET' }); };
        const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
      } }) as Pool;
      const interrupted = new AgentTaskControlRepository(() => failingPool);
      await assert.rejects(interrupted.grantDispatchPermit(coordinates(input)), (error: any) => error.code === 'ECONNRESET');
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.state, 'active');
      const recovered = await fx.repo.grantDispatchPermit(coordinates(input));
      assert.equal(recovered.fresh, true);
      assert.equal(recovered.task.writeReserved, 1);
      assert.equal(recovered.invocation.invocationId, input.invocationId);
    });

    await t.test('expiry blocks new dispatch while the original task remains readable', async () => {
      const fx = await setup({ expiresAt: '2030-01-01T00:00:00Z' });
      const { input } = await fx.reserve(0);
      const later = new AgentTaskControlRepository(() => pool, { now: () => '2030-01-02T00:00:00Z' });
      await assert.rejects(later.grantDispatchPermit(coordinates(input)), code('TASK_EXPIRED'));
      assert.equal((await later.getTask(fx.task.taskId))!.activePermits, 0);
      assert.equal((await jobMetadata(input.jobId)).agent_dispatch_attempted, false);
    });

    await t.test('denied or explicitly abandoned reservations release budget without inventing permits', async () => {
      const fx = await setup({ maxWriteCalls: 1 });
      const first = await fx.reserve(0, { approvalRequired: true });
      const approvalId = await approval(first.input, 'pending');
      await assert.rejects(fx.repo.releaseReservation({ ...coordinates(first.input), reason: 'approval_denied', approvalId }), code('TASK_APPROVAL_NOT_READY'));
      await pool.query("UPDATE bz_tool_approvals SET status='denied' WHERE id=?", [approvalId]);
      const denied = await fx.repo.releaseReservation({ ...coordinates(first.input), reason: 'approval_denied', approvalId });
      assert.equal(denied.fresh, true);
      assert.equal(denied.invocation.permitId, null);
      assert.equal(denied.invocation.terminal, true);
      assert.equal(denied.task.writeReserved, 0);
      const repeated = await fx.repo.releaseReservation({ ...coordinates(first.input), reason: 'approval_denied', approvalId });
      assert.equal(repeated.fresh, false);
      const second = await fx.reserve(0);
      const abandoned = await fx.repo.releaseReservation({ ...coordinates(second.input), reason: 'abandoned', actor: 'example-administrator' });
      assert.equal(abandoned.task.writeReserved, 0);
      assert.equal(abandoned.task.writeConsumed, 0);
      assert.equal(abandoned.task.activePermits, 0);
      await assert.rejects(fx.repo.grantDispatchPermit(coordinates(second.input)), code('TASK_INVOCATION_TERMINAL'));
      const third = await fx.reserve(0);
      await fx.repo.grantDispatchPermit(coordinates(third.input));
      await assert.rejects(fx.repo.releaseReservation({ ...coordinates(third.input), reason: 'abandoned', actor: 'example-administrator' }), code('TASK_RESERVATION_NOT_RELEASABLE'));
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.writeReserved, 1);
    });

    await t.test('the same consumed approval is reusable only after trusted no-dispatch evidence for its original operation', async () => {
      const fx = await setup();
      const { input } = await fx.reserve(0, { approvalRequired: true });
      const approvalId = await approval(input);
      const first = await fx.repo.grantDispatchPermit({ ...coordinates(input), approvalId });
      const [before]: any = await pool.query('SELECT used_at FROM bz_tool_approvals WHERE id=?', [approvalId]);
      assert.ok(before[0].used_at);
      await fx.repo.settlePermit({ ...coordinates(input), permitId: first.invocation.permitId!, outcome: 'confirmed_not_dispatched', terminal: false });
      const second = await fx.repo.grantDispatchPermit({ ...coordinates(input), approvalId, retryOriginal: true });
      const [after]: any = await pool.query('SELECT used_at FROM bz_tool_approvals WHERE id=?', [approvalId]);
      assert.equal(after[0].used_at, before[0].used_at);
      assert.equal(second.invocation.approvalId, approvalId);
      assert.equal(second.invocation.attempt, 2);
      assert.equal(second.task.writeReserved, 1);
      await fx.repo.settlePermit({ ...coordinates(input), permitId: second.invocation.permitId!, outcome: 'unknown', terminal: false });
      const retry = await fx.repo.grantDispatchPermit({ ...coordinates(input), approvalId, retryOriginal: true });
      assert.equal(retry.fresh, false);
      assert.equal(retry.invocation.attempt, 2);
      assert.equal(retry.invocation.permitId, second.invocation.permitId);
    });

    await t.test('a committed grant with a lost acknowledgement never grants another fresh dispatch after reconnect', async () => {
      const fx = await setup();
      const { input } = await fx.reserve(0);
      const lostAckPool = new Proxy(pool, { get(target, prop) {
        if (prop !== 'getConnection') { const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; }
        return async () => {
          const connection = await target.getConnection();
          return new Proxy(connection, { get(conn, key) {
            if (key === 'commit') return async () => { await conn.commit(); throw Object.assign(new Error('synthetic_commit_ack_lost'), { code: 'ECONNRESET' }); };
            const value = Reflect.get(conn, key); return typeof value === 'function' ? value.bind(conn) : value;
          } });
        };
      } }) as Pool;
      const interrupted = new AgentTaskControlRepository(() => lostAckPool);
      await assert.rejects(interrupted.grantDispatchPermit(coordinates(input)), (error: any) => error.code === 'ECONNRESET');
      const restored = new AgentTaskControlRepository(() => pool);
      const receipt = await restored.grantDispatchPermit(coordinates(input));
      assert.equal(receipt.fresh, false);
      assert.equal(receipt.invocation.attempt, 1);
      assert.equal(receipt.task.activePermits, 1);
      assert.equal(receipt.task.writeReserved, 1);
      assert.equal((await jobMetadata(input.jobId)).agent_task_permit_id, receipt.invocation.permitId);
    });

    await t.test('corrupted original request or principal records cannot reserve budget', async () => {
      const fx = await setup();
      const wrongRequest = { taskId: fx.task.taskId, ...await seedTaskMysqlInvocation(pool, fx.members[0]!) };
      await pool.query('UPDATE bz_jobs SET request_id=? WHERE job_id=?', [`agent-tool:${'e'.repeat(64)}`, wrongRequest.jobId]);
      await assert.rejects(fx.repo.reserveInvocation(wrongRequest), code('TASK_INVOCATION_CONFLICT'));
      const wrongPrincipal = { taskId: fx.task.taskId, ...await seedTaskMysqlInvocation(pool, fx.members[0]!, {
        extraMetadata: { principal: { ...fx.members[0]!.principal, tenant: 'other-example-tenant' } },
      }) };
      await assert.rejects(fx.repo.reserveInvocation(wrongPrincipal), code('TASK_INVOCATION_CONFLICT'));
      assert.equal((await fx.repo.getTask(fx.task.taskId))!.writeReserved, 0);
    });

    await t.test('the original reservation survives its completed run without admitting new operations on that run', async () => {
      const fx = await setup();
      const { input } = await fx.reserve(0);
      await pool.query("UPDATE bz_agent_client_runs SET status='completed',completed_at=NOW() WHERE run_id=?", [input.runId]);
      const restored = new AgentTaskControlRepository(() => pool);
      assert.equal((await restored.reserveInvocation(input)).fresh, false);
      assert.equal((await restored.grantDispatchPermit(coordinates(input))).fresh, true);
      const newOperation = { taskId: fx.task.taskId, ...await seedTaskMysqlInvocation(pool, fx.members[0]!) };
      await assert.rejects(restored.reserveInvocation(newOperation), code('TASK_RUN_INACTIVE'));
      assert.equal((await restored.getTask(fx.task.taskId))!.writeReserved, 1);
    });
  } finally { await pool.end(); }
});
