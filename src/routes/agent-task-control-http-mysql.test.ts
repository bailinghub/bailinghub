import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { Principal } from '../app/auth';
import { send } from '../app/http';
import { ConfigStore } from '../infrastructure/config/configstore';
import { MysqlStore } from '../infrastructure/state/state-mysql';
import type { ToolProxyDeps } from '../app/tool-proxy';
import { handleAgentApiHttpFor } from './agent-api';
import { handleAdminAgentTasksApiFor } from './admin-agent-tasks';
import { tokenHash } from './agent-auth';
import { openTaskMysqlFixture, seedTaskMysqlMembers, taskMysqlConfigPath } from '../test-support/agent-task-control-mysql-fixture';

const listen = (server: Server) => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => {
  const address = server.address(); assert.ok(address && typeof address === 'object'); resolve(`http://127.0.0.1:${address.port}`);
}));
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const id = () => randomBytes(32).toString('hex');
const tools = ['product_update', 'inventory_read', 'product_review'];
function spec() {
  const operation = (name: string, write: boolean, approval: boolean) => ({
    operationId: name, summary: name,
    'x-agent-capability': { version: 1, enabled: true, scope: write ? 'products.write' : 'inventory.read', subject: { required: true },
      ...(approval ? { risk: { level: 'high' } } : {}) },
    ...(write ? { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } } } } }
      : { parameters: [{ name: 'id', in: 'query', schema: { type: 'integer' } }] }),
  });
  return JSON.stringify({ openapi: '3.0.0', info: { title: 'Example shop and inventory', version: '1' }, paths: {
    '/product': { post: operation('product_update', true, false) },
    '/inventory': { get: operation('inventory_read', false, false) },
    '/review': { post: operation('product_review', true, true) },
  } });
}

test('task control gates real HTTP dispatch through the persisted Core runtime', { skip: !taskMysqlConfigPath }, async (t) => {
  const pool = await openTaskMysqlFixture();
  const owner = { get: async () => pool, close: async () => undefined };
  const config = new ConfigStore({} as AppConfig['state']['mysql'], owner);
  const state = new MysqlStore({} as AppConfig['state']['mysql'], owner);
  await config.init(); await state.init();
  const requests: Array<{ url: string; subject: string }> = [];
  let dropResponse = false;
  let holdBusinessResponse: Promise<void> | null = null;
  let dropCoreAck = false;
  const business = createServer(async (req, res) => {
    requests.push({ url: req.url ?? '', subject: String(req.headers['x-agent-on-behalf-of'] ?? '') });
    if (dropResponse) { req.socket.destroy(); return; }
    if (holdBusinessResponse) await holdBusinessResponse;
    send(res, 200, { ok: true, synthetic: true });
  });
  const businessUrl = await listen(business);
  const cfg = { brand: { name: 'BailingHub' }, server: { token: 'synthetic-test-server-secret' } } as AppConfig;
  const toolProxyDeps: ToolProxyDeps = { cfg, configStore: config, stateStore: state, toolIndex: null,
    now: () => new Date().toISOString(), sleep: async () => undefined };
  let legacyRuns = 0;
  const core = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://127.0.0.1');
      if (dropCoreAck && url.pathname === '/agent-api/v1/tool-invocations' && req.method === 'POST') {
        dropCoreAck = false;
        res.end = (() => { res.destroy(); return res; }) as typeof res.end;
      }
      if (url.pathname.startsWith('/admin/')) {
        const principal: Principal = req.headers.authorization === 'Bearer synthetic-admin'
          ? { kind: 'admin', via: 'token' } : { kind: 'admin', via: 'session', role: 'viewer' };
        if (await handleAdminAgentTasksApiFor(config, req.method!, url.pathname, req, res, principal)) return;
      }
      if (await handleAgentApiHttpFor({ configStore: config, stateStore: state, isPaused: () => false, toolProxyDeps,
        handleRun: async (_req, result) => { legacyRuns++; send(result, 200, {}); } }, req, res, url)) return;
      send(res, 404, { error: 'not_found' });
    } catch (error) { send(res, 500, { error: error instanceof Error ? error.message : 'test_server_error' }); }
  });
  const coreUrl = await listen(core);
  const request = async (path: string, bearer: string, body?: unknown) => {
    const response = await fetch(`${coreUrl}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const setup = async (maxWrites: number | null = 2, longClientId = false) => {
    const members = await seedTaskMysqlMembers(pool);
    const bearers: string[] = [];
    for (const member of members) {
      if (longClientId) {
        const fullId = `business-${id()}`.slice(0, 64);
        await pool.query('UPDATE bz_clients SET app_id=? WHERE app_id=?', [fullId, member.clientAppId]);
        await pool.query('UPDATE bz_agent_sessions SET client_app_id=? WHERE session_id=?', [fullId, member.sessionId]);
        await pool.query('UPDATE bz_agent_client_runs SET client_app_id=? WHERE run_id=?', [fullId, member.runId]);
        member.clientAppId = fullId;
      }
      const bearer = `bha_${randomBytes(32).toString('base64url')}`; bearers.push(bearer);
      await pool.query('UPDATE bz_agent_sessions SET access_token_hash=? WHERE session_id=?', [tokenHash(bearer), member.sessionId]);
      await config.toolProviders.upsert({ name: member.clientAppId, base_url: businessUrl, secret: 'synthetic-provider-secret',
        enabled: true, spec_source: 'inline', spec_json: spec(), log_payload: false, timeout_ms: 1000, rate_limit_per_min: 0, auto_refresh_min: 0 });
      const route = (await config.routes.get(member.route))!;
      await config.routes.upsert({ ...route, permission: 'full', audience: { enabled: true, roles: ['manager'], clients: [member.clientAppId] },
        tools: { sources: [{ provider: member.clientAppId, allow: ['products.write', 'inventory.read'] }], max_calls: 12,
          agent_direct: { enabled: true, write_tools: ['product_update', 'product_review'] } }, agent_client: { enabled: true } });
    }
    const body = { request_id: randomUUID(), members: members.map((m) => ({ session_id: m.sessionId, client_app_id: m.clientAppId,
      workspace: m.route, client_conversation_id: m.clientConversationId, allowed_tools: tools })),
      policy: { max_write_calls: maxWrites, max_concurrent: 2, expires_at: null } };
    const created = await request('/admin/api/agent-tasks', 'synthetic-admin', body);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const task = created.body;
    const binding = { schema_version: 'bailing.agent-task-binding.v1', task_id: task.task_id, scope_hash: task.scope_hash };
    const turnBody = (index = 0) => ({ client_conversation_id: members[index]!.clientConversationId, client_turn_id: randomUUID(),
      user_message_id: randomUUID(), user_input: 'synthetic product task', task_binding: binding });
    const turn = async (index = 0) => {
      const result = await request(`/agent-api/v1/workspaces/${members[index]!.route}/turns`, bearers[index]!, turnBody(index));
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.deepEqual(result.body.task_binding, binding); return result.body;
    };
    const invoke = async (context: any, tool = 'product_update', index = 0, invocationId = id()) => {
      const input = { invocation_id: invocationId, route: members[index]!.route, capability_revision: context.capability_revision,
        agent_run_id: context.run_id, tool, arguments: { id: 1 } };
      return { ...await request('/agent-api/v1/tool-invocations', bearers[index]!, input), input };
    };
    const detail = () => request(`/admin/api/agent-tasks/${task.task_id}`, 'synthetic-admin');
    const control = async (action: string) => {
      const current = (await detail()).body.task;
      const result = await request(`/admin/api/agent-tasks/${task.task_id}/control`, 'synthetic-admin', {
        request_id: randomUUID(), expected_revision: current.revision, action });
      assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
    };
    return { members, bearers, task, body, binding, turnBody, turn, invoke, detail, control };
  };
  try {
    await t.test('admin scope creation is idempotent, snapshots disclose only the original member, and omission cannot bypass task admission', async () => {
      const fx = await setup();
      assert.equal((await request('/admin/api/agent-tasks', 'synthetic-admin', fx.body)).body.task_id, fx.task.task_id);
      assert.equal((await request('/admin/api/agent-tasks', fx.bearers[0]!, fx.body)).status, 403);
      const capabilities = await request('/agent-api/v1/task-control/capabilities', fx.bearers[0]!);
      assert.equal(capabilities.body.supported, true); assert.equal(capabilities.body.mode, 'required');
      const snapshot = await request(`/agent-api/v1/tasks/${fx.task.task_id}?workspace=${fx.members[0]!.route}&client_conversation_id=${fx.members[0]!.clientConversationId}`, fx.bearers[0]!);
      assert.equal(snapshot.status, 200); assert.equal(snapshot.body.member_count, 2);
      assert.equal(snapshot.body.member.session_id, fx.members[0]!.sessionId);
      assert.equal(JSON.stringify(snapshot.body).includes(fx.members[1]!.sessionId), false);
      assert.equal(JSON.stringify(snapshot.body).includes('identityHash'), false);
      const { task_binding: _binding, ...withoutTask } = fx.turnBody();
      const omitted = await request(`/agent-api/v1/workspaces/${fx.members[0]!.route}/turns`, fx.bearers[0]!, withoutTask);
      assert.equal(omitted.body.error, 'TASK_REQUIRED');
      const legacy = await request('/agent-api/v1/run', fx.bearers[0]!, {});
      assert.equal(legacy.body.error, 'TASK_REQUIRED'); assert.equal(legacyRuns, 0);
      const [rows]: any = await pool.query('SELECT COUNT(*) AS n FROM bz_agent_client_runs WHERE client_turn_id=?', [withoutTask.client_turn_id]);
      assert.equal(Number(rows[0].n), 0);
    });
    await t.test('two systems and new turns share cumulative writes; readonly calls do not spend write budget; fences survive result persistence', async () => {
      const fx = await setup(2); const before = requests.length;
      const a = await fx.turn(0), b = await fx.turn(1);
      for (const [context, index] of [[a, 0], [b, 1]] as const) {
        const result = await fx.invoke(context, 'product_update', index);
        assert.equal(result.body.state, 'executed', JSON.stringify(result.body));
        const duplicate = await request('/agent-api/v1/tool-invocations', fx.bearers[index]!, result.input);
        assert.equal(duplicate.body.state, 'executed');
      }
      const next = await fx.turn(0);
      assert.equal((await fx.invoke(next)).body.error, 'TASK_WRITE_BUDGET_EXHAUSTED');
      assert.equal((await fx.invoke(next, 'inventory_read')).body.state, 'executed');
      assert.equal(requests.length - before, 3);
      const detail = (await fx.detail()).body;
      assert.equal(detail.task.counters.write_consumed, 2); assert.equal(detail.task.counters.write_reserved, 0);
      assert.equal(detail.task.counters.active_permits, 0);
      for (const invocation of detail.invocations) {
        const job = (await state.getJob(invocation.job_id))!;
        assert.equal(job.metadata.agent_task_id, fx.task.task_id); assert.equal(job.metadata.agent_dispatch_attempted, true);
        assert.ok(job.metadata.agent_task_permit_id); assert.equal(job.metadata.agent_frozen_arguments, undefined);
      }
    });
    await t.test('approval only reserves; paused resume cannot consume approval; inspection is read only; explicit original resume dispatches once', async () => {
      const fx = await setup(1); const before = requests.length;
      const context = await fx.turn(); const result = await fx.invoke(context, 'product_review');
      assert.equal(result.body.state, 'awaiting_approval', JSON.stringify(result.body));
      const approvalId = result.body.approval_id;
      assert.equal((await fx.detail()).body.task.counters.write_reserved, 1);
      await pool.query("UPDATE bz_tool_approvals SET status='approved' WHERE id=?", [approvalId]);
      await fx.control('pause');
      const path = `/agent-api/v1/tool-invocations/${result.input.invocation_id}`;
      const receipt = await request(`${path}/receipt`, fx.bearers[0]!);
      assert.equal(receipt.body.read_only, true, JSON.stringify(receipt)); assert.equal(receipt.body.approval.status, 'approved');
      const paused = await request(`${path}/resume`, fx.bearers[0]!, {});
      assert.equal(paused.body.error, 'TASK_PAUSED', JSON.stringify(paused.body));
      const [rows]: any = await pool.query('SELECT used_at FROM bz_tool_approvals WHERE id=?', [approvalId]);
      assert.equal(rows[0].used_at, null); assert.equal(requests.length, before);
      await fx.control('resume');
      const resumed = await request(`${path}/resume`, fx.bearers[0]!, {});
      assert.equal(resumed.body.state, 'executed', JSON.stringify(resumed.body));
      assert.equal((await request(`${path}/resume`, fx.bearers[0]!, {})).body.state, 'executed');
      assert.equal(requests.length, before + 1);
      assert.equal((await fx.detail()).body.task.counters.write_consumed, 1);
    });
    await t.test('lost business response holds the original reservation and permit; resume never duplicates the write', async () => {
      const fx = await setup(1); const before = requests.length; const context = await fx.turn();
      dropResponse = true;
      const result = await fx.invoke(context); dropResponse = false;
      assert.equal(result.body.state, 'reconciliation_required', JSON.stringify(result.body));
      const retried = await request(`/agent-api/v1/tool-invocations/${result.input.invocation_id}/resume`, fx.bearers[0]!, {});
      assert.equal(retried.body.state, 'reconciliation_required'); assert.equal(requests.length, before + 1);
      const counters = (await fx.detail()).body.task.counters;
      assert.equal(counters.write_reserved, 1); assert.equal(counters.write_consumed, 0); assert.equal(counters.active_permits, 1);
    });
    await t.test('revoking any original member blocks dispatch in the other system; cancel does not unenroll the Session', async () => {
      const fx = await setup(); const before = requests.length; const context = await fx.turn();
      await pool.query('UPDATE bz_agent_sessions SET revoked_at=NOW() WHERE session_id=?', [fx.members[1]!.sessionId]);
      assert.equal((await fx.invoke(context)).body.error, 'TASK_SCOPE_BLOCKED');
      assert.equal(requests.length, before); assert.equal((await fx.detail()).body.task.state, 'blocked');
      await fx.control('cancel');
      const { task_binding: _binding, ...withoutTask } = fx.turnBody();
      assert.equal((await request(`/agent-api/v1/workspaces/${fx.members[0]!.route}/turns`, fx.bearers[0]!, withoutTask)).body.error, 'TASK_REQUIRED');
    });
    await t.test('a lost Core acknowledgement is recovered from the original journal without a second business request', async () => {
      const fx = await setup(1); const context = await fx.turn(); const before = requests.length;
      const invocationId = id(); dropCoreAck = true;
      await assert.rejects(fx.invoke(context, 'product_update', 0, invocationId));
      const receipt = await request(`/agent-api/v1/tool-invocations/${invocationId}/receipt`, fx.bearers[0]!);
      assert.equal(receipt.body.result.state, 'executed', JSON.stringify(receipt));
      assert.equal((await request(`/agent-api/v1/tool-invocations/${invocationId}/resume`, fx.bearers[0]!, {})).body.state, 'executed');
      assert.equal(requests.length, before + 1); assert.equal((await fx.detail()).body.task.counters.write_consumed, 1);
    });
    await t.test('maximum-length client IDs dispatch and inspect without losing the full authorization identity', async () => {
      const fx = await setup(1, true); const context = await fx.turn(); const before = requests.length;
      const result = await fx.invoke(context);
      assert.equal(result.body.state, 'executed', JSON.stringify(result.body)); assert.equal(requests.length, before + 1);
      const invocation = (await fx.detail()).body.invocations[0]; const job = (await state.getJob(invocation.job_id))!;
      assert.equal(job.source.length, 32); assert.equal(job.client_app_id, fx.members[0]!.clientAppId); assert.equal(job.client_app_id!.length, 64);
      const receipt = await request(`/agent-api/v1/tool-invocations/${result.input.invocation_id}/receipt`, fx.bearers[0]!);
      assert.equal(receipt.body.result.state, 'executed', JSON.stringify(receipt.body));
    });
    await t.test('read and write share concurrency; cancel retains prior permits and accepts their late receipts', async () => {
      const fx = await setup(4); const context = await fx.turn(); const before = requests.length;
      let release!: () => void; holdBusinessResponse = new Promise<void>((resolve) => { release = resolve; });
      const pending = [fx.invoke(context), fx.invoke(context, 'inventory_read')];
      try {
        for (let i = 0; requests.length < before + 2 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(requests.length, before + 2);
        assert.equal((await fx.invoke(context, 'inventory_read')).body.error, 'TASK_CONCURRENCY_EXHAUSTED');
        assert.equal((await fx.detail()).body.task.counters.active_permits, 2);
        await fx.control('cancel');
      } finally { holdBusinessResponse = null; release(); }
      const results = await Promise.all(pending); results.forEach((result) => assert.equal(result.body.state, 'executed', JSON.stringify(result.body)));
      const detail = (await fx.detail()).body.task;
      assert.equal(detail.state, 'cancelled'); assert.equal(detail.counters.active_permits, 0); assert.equal(detail.counters.write_consumed, 1);
      assert.equal((await fx.invoke(context)).body.error, 'TASK_CANCELLED'); assert.equal(requests.length, before + 2);
    });
  } finally { await close(core); await close(business); await pool.end(); }
});
