import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { AgentSession, Client, Route } from '../core/contracts/types';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { KbService } from '../services/kb';
import { agentKnowledgeDocumentRevision } from '../services/kb';
import type { AgentClientRuntimeDeps } from './agent-client-runtime';
import { AgentToolApiError } from './agent-tool-invocations';
import { AGENT_KNOWLEDGE_LIMITS, getAgentKnowledgeCapabilitiesFor, prepareAgentKnowledgeFor, readAgentKnowledgeFor, searchAgentKnowledgeFor } from './agent-knowledge';

const RUN = '22222222-2222-4222-8222-222222222222';
const RUN2 = '33333333-3333-4333-8333-333333333333';
function fixture(content = '装修页必须绑定页面设置才生效。\n\n完整步骤应当按需读取。') {
  let stamp = Date.parse('2026-10-21T00:00:00Z');
  const route: Route = { route_key: 'knowledge-only', name: 'Knowledge', enabled: true, target: 'llm', target_config: {},
    profile: 'general', permission: 'read', session_policy: 'new', agent_client: { enabled: true },
    knowledge: { kb_ids: ['allowed'], inject: 'doc', top_k: 8, min_score: 0.5 } };
  const client: Client = { app_id: 'example-business', name: 'Example', token: 'not-returned', allowed_routes: ['knowledge-only'],
    allowed_channels: [], rate_limit_per_min: 0, enabled: true };
  const session: AgentSession = { session_id: '11111111-1111-4111-8111-111111111111', client_app_id: client.app_id,
    device_label: 'test', principal: { id: 'user1', tenant: 'tenant1', roles: ['admin'] }, on_behalf_of: 'tenant1:user1',
    allowed_routes: ['knowledge-only'], created_at: '2026-01-01T00:00:00Z', access_expires_at: '2099-01-01T00:00:00Z', refresh_expires_at: '2099-02-01T00:00:00Z' };
  const document = { kb_id: 'allowed', doc_id: 9, title: 'DIY 装修', content,
    revision: agentKnowledgeDocumentRevision('DIY 装修', content) };
  let readable = true; let resultStatus: 'ok' | 'partial' | 'unavailable' = 'ok'; let runStatus = 'context_ready';
  let duringSearch: (() => void) | undefined;
  const knowledge = {
    searchForAgent: async () => { duringSearch?.(); return { status: resultStatus,
      documents: resultStatus === 'unavailable' ? [] : [{ ...document, summary: document.content, score: 0.8 }], truncated: false }; },
    getAgentDocumentSnapshot: async (kb: string, id: number) => readable && kb === document.kb_id && id === document.doc_id ? { ...document } : null,
  };
  const store = { routes: { get: async () => route }, clients: { get: async () => client },
    agentAuth: { getBusinessSession: async () => session }, agentClientRuntime: { getRun: async (id: string) => [RUN, RUN2].includes(id)
      ? { route_key: route.route_key, status: runStatus, completed_at: null } : null } } as unknown as ConfigStoreContract;
  const state = { appendAudit: async () => { throw new Error('knowledge must not write an audit containing body'); } } as unknown as RuntimeStateStore;
  const deps: AgentClientRuntimeDeps = { toolProxyDeps: { cfg: { server: { token: 'synthetic-agent-knowledge-secret' } } as AppConfig,
    configStore: store, stateStore: state, toolIndex: null, sleep: async () => undefined, now: () => new Date(stamp).toISOString() }, kbService: knowledge as unknown as KbService, stateStore: state };
  const auth = () => ({ client: structuredClone(client), session: structuredClone(session) });
  const search = async (run_id?: string) => searchAgentKnowledgeFor(deps, auth(), route.route_key, { query: '装修', ...(run_id ? { run_id } : {}) });
  return { deps, route, client, session, document, auth, search, setReadable: (value: boolean) => { readable = value; },
    setStatus: (value: typeof resultStatus) => { resultStatus = value; }, setRunStatus: (value: string) => { runStatus = value; },
    advance: (ms: number) => { stamp += ms; }, onSearch: (fn: () => void) => { duringSearch = fn; } };
}
const firstRef = (result: Record<string, unknown>) => (result.hints as Array<{ ref: string }>)[0]!.ref;
const code = (expected: string) => (error: unknown) => error instanceof AgentToolApiError && error.code === expected;

test('knowledge-only workspace probes and searches without loading tools, memory or business data', async () => {
  const f = fixture(); const caps = await getAgentKnowledgeCapabilitiesFor(f.deps, f.auth(), f.route.route_key);
  assert.equal(caps.enabled, true); assert.deepEqual(caps.limits, AGENT_KNOWLEDGE_LIMITS);
  const result = await f.search(); const hints = result.hints as Array<Record<string, unknown>>;
  assert.equal(result.status, 'ok'); assert.equal(hints.length, 1);
  assert.match(String(hints[0]!.summary), /必须绑定页面设置/);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 4096);
  assert.doesNotMatch(JSON.stringify(result), /not-returned|synthetic-agent-knowledge-secret|active_tools|memory|"content"/);
  const read = await readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { ref: firstRef(result) });
  assert.equal(read.content, f.document.content); assert.equal(read.next_cursor, null); assert.equal(read.truncated, false);
});

test('disabled, empty, partial and unavailable are distinct from search success', async () => {
  const f = fixture(); f.route.knowledge = undefined;
  assert.equal((await f.search()).status, 'disabled'); f.route.knowledge = { kb_ids: ['allowed'] };
  f.setStatus('partial'); assert.equal((await f.search()).status, 'partial');
  f.setStatus('unavailable'); const unavailable = await f.search();
  assert.equal(unavailable.status, 'unavailable'); assert.deepEqual(unavailable.hints, []);
});

test('references cannot cross principal, tenant, session, client, route, or be forged', async () => {
  for (const boundary of ['principal', 'tenant', 'session', 'client', 'route', 'forged'] as const) {
    const f = fixture(); const ref = firstRef(await f.search());
    if (boundary === 'principal') f.session.principal.id = 'other';
    if (boundary === 'tenant') f.session.principal.tenant = 'other';
    if (boundary === 'session') f.session.session_id = '99999999-9999-4999-8999-999999999999';
    if (boundary === 'client') { f.client.app_id = 'other'; f.session.client_app_id = 'other'; }
    if (boundary === 'route') { f.route.route_key = 'other-route'; f.client.allowed_routes = ['other-route']; f.session.allowed_routes = ['other-route']; }
    await assert.rejects(readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key,
      { ref: boundary === 'forged' ? ref.slice(0, -3) + 'XXX' : ref }), code('knowledge_reference_invalid'), boundary);
  }
});

test('same-count KB swap and route policy changes invalidate the separate scope revision', async () => {
  const f = fixture(); const before = await f.search(); f.route.knowledge = { kb_ids: ['other'] };
  await assert.rejects(readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { ref: firstRef(before) }), code('knowledge_scope_changed'));
});

test('document title, body, ready status, deletion and disabled KB invalidate old references', async () => {
  for (const boundary of ['title', 'body', 'unreadable']) {
    const f = fixture(); const ref = firstRef(await f.search());
    if (boundary === 'title') f.document.title = 'Changed';
    if (boundary === 'body') f.document.content += ' changed';
    f.document.revision = agentKnowledgeDocumentRevision(f.document.title, f.document.content);
    if (boundary === 'unreadable') f.setReadable(false);
    await assert.rejects(readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { ref }), code('knowledge_changed'));
  }
});

test('references and cursors expire, reject tampering, and stay bound to their original run', async () => {
  const f = fixture('中文\\"😀'.repeat(3000)); const ref = firstRef(await f.search(RUN));
  await assert.rejects(readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { ref }), code('knowledge_reference_invalid'));
  await assert.rejects(readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { ref, run_id: RUN2 }), code('knowledge_reference_invalid'));
  const page = await readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { ref, run_id: RUN, max_bytes: 4096 });
  assert.equal(typeof page.next_cursor, 'string');
  await assert.rejects(readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { ref, run_id: RUN, cursor: String(page.next_cursor) + 'x' }), code('knowledge_reference_invalid'));
  f.advance(300001);
  await assert.rejects(readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { ref, run_id: RUN }), code('knowledge_reference_expired'));
});

test('UTF8 pages respect complete JSON byte budgets and the reference chain budget is explicit', async () => {
  const f = fixture('中文\\"😀\n'.repeat(17000)); const ref = firstRef(await f.search());
  let cursor: string | undefined; let assembled = ''; let page: Record<string, unknown>;
  do {
    page = await readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { ref, max_bytes: 4096, ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 4096);
    assert.doesNotMatch(String(page.content), /\uFFFD/); assembled += String(page.content);
    cursor = typeof page.next_cursor === 'string' ? page.next_cursor : undefined;
  } while (cursor);
  assert.ok(f.document.content.startsWith(assembled));
  assert.ok(Buffer.byteLength(assembled, 'utf8') <= AGENT_KNOWLEDGE_LIMITS.read_chain_max_bytes);
  assert.equal(page!.budget_exhausted, true); assert.equal(page!.truncated, true);
  assert.ok(Buffer.byteLength(assembled, 'utf8') >= AGENT_KNOWLEDGE_LIMITS.read_chain_max_bytes - 4);
});

test('public search rejects preparing/completed runs; server-only prepare issues refs for later ready reads', async () => {
  const f = fixture(); f.setRunStatus('preparing');
  await assert.rejects(f.search(RUN), code('run_not_found'));
  const prepared = await prepareAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { query: '装修', run_id: RUN });
  const ref = firstRef(prepared);
  await assert.rejects(readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { ref, run_id: RUN }), code('run_not_found'));
  f.setRunStatus('context_ready'); assert.equal((await readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { ref, run_id: RUN })).content, f.document.content);
  f.setRunStatus('completed'); await assert.rejects(f.search(RUN), code('run_not_found'));
});

test('async session revocation and route permission changes fail closed before hints are returned', async () => {
  for (const boundary of ['session', 'client', 'route']) {
    const f = fixture(); f.onSearch(() => {
      if (boundary === 'session') f.session.revoked_at = '2026-10-21T00:00:00Z';
      if (boundary === 'client') f.client.enabled = false;
      if (boundary === 'route') f.route.enabled = false;
    });
    await assert.rejects(f.search(), code(boundary === 'route' ? 'route_unavailable' : 'unauthorized'));
  }
});

test('read limits, query bounds and missing signing key fail safely', async () => {
  const f = fixture();
  await assert.rejects(searchAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { query: '' }), code('invalid_request'));
  await assert.rejects(readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { ref: 'anything', max_bytes: 4095 }), code('invalid_request'));
  f.deps.toolProxyDeps.cfg.server.token = '';
  await assert.rejects(f.search(), code('knowledge_unavailable'));
});

test('read and search recheck document revisions after asynchronous final authorization', async () => {
  for (const operation of ['read', 'search']) {
    const f = fixture(); const ref = firstRef(await f.search());
    let calls = 0;
    f.deps.toolProxyDeps.configStore!.clients.get = async () => {
      calls++;
      if (calls === 2) {
        f.document.content = 'A different document version';
        f.document.revision = agentKnowledgeDocumentRevision(f.document.title, f.document.content);
      }
      return f.client;
    };
    if (operation === 'read') {
      await assert.rejects(readAgentKnowledgeFor(f.deps, f.auth(), f.route.route_key, { ref }), code('knowledge_changed'));
    } else {
      const result = await f.search(); assert.deepEqual(result.hints, []); assert.equal(result.truncated, true);
    }
  }
});
