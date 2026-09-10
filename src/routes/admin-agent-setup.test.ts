import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Route } from '../core/contracts/types';
import { agentSetupRevision } from '../core/config/agent-setup';
import type { AgentSetupUpdate } from '../core/config/agent-setup';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { TargetRegistry } from '../core/targets/registry';
import { handleAdminAgentSetupFor } from './admin-agent-setup';
import { handleAdminApiFor, type AdminApiDeps } from './admin';

class Response {
  statusCode = 0;
  body = '';
  writeHead(code: number) { this.statusCode = code; }
  setHeader() {}
  end(value = '') { this.body = String(value); }
  json() { return JSON.parse(this.body); }
}

function request(body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.headers = {};
  return req;
}

function fixture() {
  let route: Route = {
    route_key: 'helpdesk', name: 'Helpdesk', enabled: true, target: 'notify', target_config: { private_setting: 'do-not-return' },
    profile: 'general', permission: 'readonly', session_policy: 'fixed', session_fixed_id: 'preserve-session',
    memory: { recent_messages: 10 }, budget: { hard_tokens: 1000 }, audience: { roles: ['staff'] },
    tools: { sources: [{ provider: 'helpdesk', allow: ['ticket.read'], subject_field: 'operator_id' }],
      max_calls: 4, approval: { type: 'manual' }, custom_extension: { preserve: true }, agent_direct: { enabled: false } },
    agent_client: { enabled: false, instructions: 'Keep existing instructions.', active_tool_limit: 3 },
  };
  let writes = 0;
  let race = false;
  const routes = {
    get: async () => route,
    compareAndSetAgentSetup: async (_key: string, revision: string, update: AgentSetupUpdate) => {
      if (race) route = { ...route, description: 'concurrent change' };
      if (revision !== agentSetupRevision(route)) return { status: 'conflict' as const };
      route = { ...route, ...update }; writes++;
      return { status: 'updated' as const, route };
    },
    upsert: async () => { throw new Error('Full route upsert is forbidden'); },
  };
  const targetRegistry = new TargetRegistry();
  targetRegistry.setTargets([{ name: 'notify', kind: 'inhub', stateless: true, needs_project: false, timeout_ms: 1000, enabled: true }]);
  const deps = { configStore: { routes, toolProviders: { get: async (name: string) => name === 'helpdesk' ? {} : null } } as unknown as ConfigStoreContract,
    defaultProfile: 'general', refreshTargets: async () => {}, targetRegistry };
  const body = () => ({ expected_revision: agentSetupRevision(route), agent_client: {
    ...route.agent_client, enabled: true, system_info: { name: 'Helpdesk', summary: 'Support ticket operations.', domains: [], boundaries: [] },
  }, tool_sources: route.tools!.sources, agent_direct: { enabled: true, write_tools: ['ticket_update'] } });
  async function call(method = 'GET', payload?: unknown) {
    const res = new Response();
    await handleAdminAgentSetupFor(deps, method, '/admin/api/routes/helpdesk/agent-setup', request(payload), res as unknown as ServerResponse);
    return res;
  }
  return { deps, routes, body, call, route: () => route, writes: () => writes, race: () => { race = true; } };
}

test('route Agent setup exposes only its editing surface and preserves all other configuration', async () => {
  const f = fixture();
  const before = structuredClone(f.route());
  const read = await f.call();
  assert.equal(read.statusCode, 200);
  assert.deepEqual(Object.keys(read.json()).sort(), ['agent_client', 'agent_direct', 'enabled', 'name', 'permission', 'revision', 'route_key', 'tool_sources']);
  assert.equal(read.json().permission, 'readonly');
  assert.doesNotMatch(read.body, /do-not-return|preserve-session|custom_extension|hard_tokens/);
  const saved = await f.call('PUT', f.body());
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(f.writes(), 1);
  const after = f.route();
  assert.deepEqual({ ...after, agent_client: before.agent_client, tools: before.tools }, before);
  assert.deepEqual({ ...after.tools, sources: before.tools!.sources, agent_direct: before.tools!.agent_direct }, before.tools);
  assert.equal(after.agent_client!.instructions, before.agent_client!.instructions);
  assert.notEqual(saved.json().revision, read.json().revision);
});

test('route Agent setup rejects stale/concurrent writes, undeclared fields and unsafe direct tools', async () => {
  for (const kind of ['stale', 'race', 'extra', 'nested', 'wildcard', 'unknown-provider'] as const) {
    const f = fixture();
    const payload: any = f.body();
    if (kind === 'stale') payload.expected_revision = '0'.repeat(64);
    if (kind === 'race') f.race();
    if (kind === 'extra') payload.target_config = {};
    if (kind === 'nested') payload.agent_client.unrecognized = true;
    if (kind === 'wildcard') payload.agent_direct.write_tools = ['*'];
    if (kind === 'unknown-provider') payload.tool_sources = [{ provider: 'unknown', allow: ['*'] }];
    const res = await f.call('PUT', payload);
    assert.equal(res.statusCode, kind === 'stale' || kind === 'race' ? 409 : 400, kind);
    assert.equal(f.writes(), 0);
  }
});

test('route Agent setup supports deliberate clearing and reports old Host save support explicitly', async () => {
  const f = fixture();
  const res = await f.call('PUT', { expected_revision: agentSetupRevision(f.route()), agent_client: null, tool_sources: [], agent_direct: null });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().agent_client, null);
  assert.equal(res.json().agent_direct, null);
  assert.deepEqual(res.json().tool_sources, []);
  assert.equal(f.route().tools!.max_calls, 4);
  delete (f.routes as Partial<typeof f.routes>).compareAndSetAgentSetup;
  const unsupported = await f.call('PUT', f.body());
  assert.equal(unsupported.statusCode, 503);
  assert.equal(unsupported.json().error, 'agent_setup_unsupported');
});

test('route Agent setup remains behind routes permissions rather than clients permissions', async () => {
  const f = fixture();
  const deps = { ...f.deps, cfg: { defaultProfile: 'general' } } as unknown as AdminApiDeps;
  for (const permissions of [['clients:write'], ['routes:read']]) {
    const response = new Response();
    await handleAdminApiFor(deps, 'PUT', '/admin/api/routes/helpdesk/agent-setup', request(f.body()), response as unknown as ServerResponse,
      { kind: 'admin', via: 'session', permissions });
    assert.equal(response.statusCode, 403);
  }
  assert.equal(f.writes(), 0);
  const read = new Response();
  await handleAdminApiFor(deps, 'GET', '/admin/api/routes/helpdesk/agent-setup', request(), read as unknown as ServerResponse,
    { kind: 'admin', via: 'session', permissions: ['routes:read'] });
  assert.equal(read.statusCode, 200);
  const write = new Response();
  await handleAdminApiFor(deps, 'PUT', '/admin/api/routes/helpdesk/agent-setup', request(f.body()), write as unknown as ServerResponse,
    { kind: 'admin', via: 'session', permissions: ['routes:write'] });
  assert.equal(write.statusCode, 200);
});
