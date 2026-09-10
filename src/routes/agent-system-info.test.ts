import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentSession, Client, Route } from '../core/contracts/types';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ToolProxyDeps } from '../app/tool-proxy';
import { AgentToolApiError, listAgentToolsFor } from '../app/agent-tool-invocations';
import { handleAgentApiHttpFor } from './agent-api';

class Response {
  statusCode = 0;
  headers: Record<string, unknown> = {};
  body = '';
  setHeader(name: string, value: unknown) { this.headers[name] = value; }
  writeHead(code: number, headers: Record<string, unknown> = {}) { this.statusCode = code; Object.assign(this.headers, headers); }
  end(value = '') { this.body = String(value); }
  json() { return JSON.parse(this.body); }
}

function fixture() {
  const token = `bha_${'s'.repeat(43)}`;
  const client: Client = {
    app_id: 'helpdesk-client', name: 'Helpdesk Client', token: 'not-returned', enabled: true,
    agent_authorize_url: 'https://helpdesk.example.com/authorize', allowed_routes: ['helpdesk'], allowed_channels: [], rate_limit_per_min: 0,
  };
  const session: AgentSession = {
    session_id: '123e4567-e89b-42d3-a456-426614174000', client_app_id: client.app_id, device_label: 'Untrusted account label',
    principal: { id: 'operator-1', tenant: 'tenant-a', roles: ['staff'] }, on_behalf_of: 'tenant-a:operator-1', allowed_routes: ['helpdesk'],
    created_at: '2026-01-01T00:00:00.000Z', access_expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-01-30T00:00:00.000Z',
  };
  const route: Route = {
    route_key: 'helpdesk', name: 'Internal routing label', enabled: true, target: 'llm', target_config: { system_prompt: 'hidden rules', credential: 'hidden-credential' },
    profile: 'general', session_policy: 'new', audience: { enabled: true, roles: ['staff'], clients: ['helpdesk-client'] },
    agent_client: { enabled: true, instructions: 'hidden local rules', system_info: {
      name: 'Helpdesk', summary: 'Manages customer support tickets.', domains: ['Ticket triage'], boundaries: ['Inventory changes belong to another system.'],
    } },
    tools: { sources: [{ provider: 'helpdesk-tools', allow: ['*'] }], agent_direct: { enabled: true } },
    memory: { recent_messages: 12 }, knowledge: { kb_id: 'hidden-knowledge' },
  };
  let active = true;
  const reads: string[] = [];
  const unexpected = new Proxy({}, { get: (_object, property) => { throw new Error(`Unexpected service access: ${String(property)}`); } });
  const configStore = {
    agentAuth: { getSessionByAccessHash: async () => active ? session : null },
    clients: { get: async () => client },
    routes: { get: async (key: string) => { reads.push(key); return key === route.route_key ? route : null; }, list: () => { throw new Error('Must not enumerate routes'); } },
    toolProviders: unexpected, conversations: unexpected, agentClientRuntime: unexpected,
  } as unknown as ConfigStoreContract;
  async function get(workspace = 'helpdesk', bearer = token) {
    let bodyReads = 0;
    const req = new Readable({ read() { bodyReads++; this.push(null); } }) as IncomingMessage;
    req.method = 'GET'; req.headers = { authorization: `Bearer ${bearer}` };
    const res = new Response();
    await handleAgentApiHttpFor({
      configStore, stateStore: unexpected as RuntimeStateStore, isPaused: () => false,
      handleRun: async () => { throw new Error('Must not start run'); },
      // Deliberately no toolProxyDeps: product descriptions do not load a tool runtime.
    }, req, res as unknown as ServerResponse, new URL(`https://hub.example.com/agent-api/v1/workspaces/${workspace}/system-info`));
    assert.equal(bodyReads, 0);
    return res;
  }
  return { route, client, session, configStore, reads, get, revoke: () => { active = false; } };
}

test('system-info reads only the selected binding before tools, body or business runs', async () => {
  const f = fixture();
  const res = await f.get();
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json(), {
    schema_version: 'bailing.agent-system-info.v1',
    binding: { client_app_id: f.client.app_id, session_id: f.session.session_id, workspace: 'helpdesk' },
    metadata_status: 'configured', revision: res.json().revision, system: f.route.agent_client!.system_info,
    tool_status: 'not_loaded', availability: 'unknown',
  });
  assert.match(res.json().revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.reads, ['helpdesk']);
  assert.doesNotMatch(res.body, /not-returned|hidden|Untrusted account label|Internal routing label/);
  const same = await f.get();
  assert.equal(same.json().revision, res.json().revision);
  f.route.agent_client!.system_info!.summary = 'Supports ticket review and response drafts.';
  assert.notEqual((await f.get()).json().revision, res.json().revision);
});

test('system-info remains readable with runtime/direct switches off, without enabling tools', async () => {
  const f = fixture();
  f.route.agent_client!.enabled = false;
  let response = await f.get();
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().metadata_status, 'configured');
  assert.equal(response.json().unavailable_reason, 'agent_client_disabled');
  f.route.agent_client!.enabled = true;
  f.route.tools!.agent_direct = { enabled: false };
  response = await f.get();
  assert.equal(response.json().availability, 'unavailable');
  assert.equal(response.json().unavailable_reason, 'agent_direct_disabled');
  await assert.rejects(listAgentToolsFor({ configStore: f.configStore } as ToolProxyDeps, f, 'helpdesk'),
    (error) => error instanceof AgentToolApiError && error.code === 'agent_direct_disabled');
});

test('system-info missing or malformed metadata stays unknown rather than inventing identity', async () => {
  const f = fixture();
  delete f.route.agent_client!.system_info;
  const res = await f.get();
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().metadata_status, 'missing');
  assert.equal(res.json().system, null);
  assert.equal(res.json().revision, null);
  f.route.agent_client!.system_info = { name: 'Helpdesk', summary: '', domains: [], boundaries: [] };
  assert.equal((await f.get()).json().metadata_status, 'missing');
});

test('system-info rejects unselected routes and wrong Client/Session/audience without metadata', async () => {
  for (const mutation of ['client-route', 'session-route', 'client-binding', 'audience', 'revoked', 'disabled-route'] as const) {
    const f = fixture();
    if (mutation === 'client-route') f.client.allowed_routes = [];
    if (mutation === 'session-route') f.session.allowed_routes = [];
    if (mutation === 'client-binding') f.client.app_id = 'another-client';
    if (mutation === 'audience') f.session.principal.roles = [];
    if (mutation === 'revoked') f.revoke();
    if (mutation === 'disabled-route') f.route.enabled = false;
    const res = await f.get();
    assert.equal(res.statusCode, mutation === 'revoked' ? 401 : mutation === 'disabled-route' ? 404 : 403, mutation);
    assert.doesNotMatch(res.body, /Manages customer|Ticket triage/);
  }
  const f = fixture();
  const res = await f.get('inventory');
  assert.equal(res.statusCode, 403);
  assert.deepEqual(f.reads, []);
});
