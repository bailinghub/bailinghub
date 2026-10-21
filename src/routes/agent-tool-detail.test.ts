import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentSession, Client, Route, ToolProvider } from '../core/contracts/types';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ToolProxyDeps } from '../app/tool-proxy';
import { listAgentToolsFor } from '../app/agent-tool-invocations';
import { handleAgentApiHttpFor } from './agent-api';

class Response {
  statusCode = 0;
  headers: Record<string, unknown> = {};
  body = '';
  setHeader(name: string, value: unknown) { this.headers[name.toLowerCase()] = value; }
  writeHead(status: number, headers: Record<string, unknown> = {}) { this.statusCode = status; Object.assign(this.headers, headers); }
  end(value = '') { this.body = String(value); }
  json() { return JSON.parse(this.body); }
}

function fixture() {
  const token = `bha_${'g'.repeat(43)}`;
  const client: Client = { app_id: 'page-client', name: 'Page Client', token: 'hidden-client-token', enabled: true,
    agent_authorize_url: 'https://pages.invalid/authorize', allowed_routes: ['pages'], allowed_channels: [], rate_limit_per_min: 0 };
  const session: AgentSession = { session_id: '123e4567-e89b-42d3-a456-426614174000', client_app_id: client.app_id, device_label: 'test',
    principal: { id: 'u1', tenant: 't1', roles: ['editor'] }, on_behalf_of: 't1:u1', allowed_routes: ['pages'],
    created_at: '2026-01-01T00:00:00.000Z', access_expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-02-01T00:00:00.000Z' };
  const route: Route = { route_key: 'pages', name: 'Pages', enabled: true, target: 'llm', target_config: {}, profile: 'general',
    session_policy: 'new', permission: 'full', audience: { enabled: true, roles: ['editor'], clients: [client.app_id] },
    tools: { sources: [{ provider: 'page-provider', allow: ['page.*'] }], agent_direct: { enabled: true, write_tools: ['page_save'], force_approval_tools: ['page_save'] } } };
  const operation = (name: string, scope: string, description: string) => ({ operationId: name, summary: '保存页面', description,
    'x-agent-capability': { enabled: true, scope, subject: { required: true }, execution: { idempotent: true },
      approval: { when: [{ param: 'id', op: '>', value: 100 }] } },
    'x-business-private': 'hidden-extension', parameters: [{ name: 'id', in: 'query', schema: { type: 'integer', 'x-secret': 'hidden-schema-extension' } }] });
  const spec = { openapi: '3.0.0', info: { title: 'Hidden full spec', version: '1' }, paths: {
    '/page': { post: operation('page_save', 'page.write', '必须绑定页面设置才生效；冲突时读取原修订。') },
    '/money': { post: operation('money_save', 'money.write', 'hidden-money-guidance') },
  } };
  const provider: ToolProvider = { name: 'page-provider', enabled: true, secret: 'hidden-provider-secret', base_url: 'https://hidden-provider.invalid', spec_source: 'inline',
    spec_json: JSON.stringify(spec), log_payload: false, timeout_ms: 1000, rate_limit_per_min: 0, auto_refresh_min: 0 };
  let active = true;
  const unexpected = new Proxy({}, { get: (_value, key) => { throw new Error(`Unexpected runtime access: ${String(key)}`); } });
  const configStore = { agentAuth: { getSessionByAccessHash: async () => active ? session : null }, clients: { get: async () => client },
    routes: { get: async (key: string) => key === route.route_key ? route : null }, toolProviders: { get: async () => provider },
    approvals: unexpected, agentClientRuntime: unexpected, toolCalls: unexpected,
  } as unknown as ConfigStoreContract;
  const proxy = { configStore, now: () => '2026-10-21T00:00:00.000Z', toolIndex: null, stateStore: unexpected } as unknown as ToolProxyDeps;
  const catalog = () => listAgentToolsFor(proxy, { client, session }, 'pages');
  async function get(name: string, revision: string, query?: string) {
    let bodyReads = 0;
    const req = new Readable({ read() { bodyReads++; this.push(null); } }) as IncomingMessage;
    req.method = 'GET'; req.headers = { authorization: `Bearer ${token}` };
    const res = new Response();
    await handleAgentApiHttpFor({ configStore, toolProxyDeps: proxy, stateStore: unexpected as RuntimeStateStore, isPaused: () => false,
      handleRun: async () => { throw new Error('No run allowed'); } }, req, res as unknown as ServerResponse,
    new URL(`https://hub.invalid/agent-api/v1/tools/${name}?${query ?? `route=pages&capability_revision=${revision}`}`));
    assert.equal(bodyReads, 0);
    return res;
  }
  return { catalog, get, route, session, provider, spec, revoke: () => { active = false; } };
}

test('named tool detail retains full authored guidance and current machine policies without a business operation', async () => {
  const f = fixture();
  const catalog = await f.catalog();
  assert.deepEqual(catalog.tools.map((tool) => tool.name), ['page_save']);
  assert.equal(catalog.tools[0]!.usage_guidance_available, true);
  assert.equal(catalog.tools[0]!.description_truncated, undefined);
  assert.doesNotMatch(JSON.stringify(catalog), /必须绑定页面设置/);
  const res = await f.get('page_save', catalog.capability_revision);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const detail = res.json();
  assert.equal(detail.schema_version, 'bailing.agent-tool-detail.v1');
  assert.deepEqual(detail.tool, JSON.parse(JSON.stringify(catalog.tools[0])));
  assert.equal(detail.tool.approval_required, true);
  assert.equal(detail.tool.idempotent, true);
  assert.match(detail.usage_guidance.text, /必须绑定页面设置才生效/);
  assert.equal(detail.usage_guidance.truncated, false);
  assert.equal(detail.usage_guidance.max_chars, 32768);
  assert.equal(detail.usage_guidance.max_bytes, 65536);
  assert.equal(detail.usage_guidance.source_bytes, Buffer.byteLength(detail.usage_guidance.text));
  assert.doesNotMatch(res.body, /hidden-|extensions|base_url|spec_json|invocation_id|job_id|approval_id/);
});

test('named tool detail revalidates revision, exact tool authorization and current Session/audience/direct gates', async () => {
  const f = fixture();
  const catalog = await f.catalog();
  assert.equal((await f.get('money_save', catalog.capability_revision)).statusCode, 404);
  f.spec.paths['/page'].post.description += '声明发生变更。';
  f.provider.spec_json = JSON.stringify(f.spec);
  const stale = await f.get('page_save', catalog.capability_revision);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, 'capability_changed');
  assert.doesNotMatch(stale.body, /必须绑定页面设置/);
  for (const gate of ['session', 'audience', 'direct', 'subject', 'scope', 'revoked'] as const) {
    const value = fixture();
    const revision = (await value.catalog()).capability_revision;
    if (gate === 'session') value.session.allowed_routes = [];
    if (gate === 'audience') value.session.principal.roles = [];
    if (gate === 'direct') value.route.tools!.agent_direct = { enabled: false };
    if (gate === 'subject') value.session.on_behalf_of = '';
    if (gate === 'scope') value.route.tools!.sources = [{ provider: 'page-provider', allow: ['unrelated.*'] }];
    if (gate === 'revoked') value.revoke();
    const response = await value.get('page_save', revision);
    assert.ok([401, 403, 409].includes(response.statusCode), gate);
    assert.doesNotMatch(response.body, /必须绑定页面设置/);
    if (gate === 'subject' || gate === 'scope') {
      const current = await value.catalog();
      assert.equal((await value.get('page_save', current.capability_revision)).statusCode, 404);
    }
  }
});

test('tool detail rejects missing, duplicate, invalid or extra query fields instead of weakening revision binding', async () => {
  const f = fixture();
  const revision = (await f.catalog()).capability_revision;
  for (const query of ['route=pages', `route=pages&capability_revision=${revision}&route=pages`,
    `route=pages&capability_revision=${revision}&include=spec`, 'route=pages&capability_revision=bad']) {
    const response = await f.get('page_save', revision, query);
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().error, 'invalid_request');
  }
});

test('long Chinese guidance returns a bounded, explicitly incomplete prefix without splitting a character', async () => {
  const f = fixture();
  f.spec.paths['/page'].post.description = '中'.repeat(30_000);
  f.provider.spec_json = JSON.stringify(f.spec);
  const catalog = await f.catalog();
  const response = await f.get('page_save', catalog.capability_revision);
  const guidance = response.json().usage_guidance;
  assert.equal(response.statusCode, 200);
  assert.equal(guidance.truncated, true);
  assert.ok(Buffer.byteLength(guidance.text, 'utf8') <= 65536);
  assert.ok(guidance.source_bytes > guidance.max_bytes);
  assert.equal(guidance.text.includes('\ufffd'), false);
  assert.ok(Buffer.byteLength(response.body) < 70 * 1024);
});
