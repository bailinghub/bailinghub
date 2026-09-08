import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { Principal } from '../app/auth';
import { handleAgentApiHttpFor } from './agent-api';
import { tokenHash } from './agent-auth';
import { handleAdminConversationAuditFor } from './admin-conversation-audit';
import { conversationAuditFixture, AUDIT_SESSION_A, AUDIT_SESSION_B, AUDIT_SESSION_C } from '../test-support/agent-conversation-audit-fixture';

class Response {
  statusCode = 0;
  headers: Record<string, unknown> = {};
  body = '';
  setHeader(name: string, value: unknown) { this.headers[name.toLowerCase()] = value; }
  writeHead(code: number, headers: Record<string, unknown> = {}) { this.statusCode = code; Object.assign(this.headers, headers); }
  end(body?: string | Buffer) { this.body = String(body ?? ''); }
  json(): any { return JSON.parse(this.body); }
}

function request(method: string, path: string, body?: unknown, token?: string): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  return req;
}

const BASE = '/agent-api/v1/conversation-audits';
function fixture() {
  const fx = conversationAuditFixture();
  const tokens = new Map([AUDIT_SESSION_A, AUDIT_SESSION_B, AUDIT_SESSION_C].map((id, index) => [id, `bha_${String(index).repeat(43)}`]));
  const store = {
    ...fx.store,
    clients: { get: async (id: string) => id === fx.client.app_id ? fx.client : null },
    agentAuth: { getSessionByAccessHash: async (hash: string) => {
      const pair = [...tokens].find(([, token]) => tokenHash(token) === hash);
      if (!pair) return null;
      const session = fx.auth(pair[0]).session;
      return session.revoked_at ? null : session;
    } },
  } as unknown as ConfigStoreContract;
  const deps = { configStore: store, stateStore: {} as RuntimeStateStore, isPaused: () => false, handleRun: async () => { throw new Error('No business dispatch is allowed'); } };
  return Object.assign(fx, { store, deps, async api(method: string, path: string, body?: unknown, sessionId: string | null = AUDIT_SESSION_A) {
    const res = new Response();
    await handleAgentApiHttpFor(deps, request(method, path, body, sessionId ? tokens.get(sessionId) : undefined), res as unknown as ServerResponse, new URL(path, 'https://hub.example.com'));
    return res;
  } });
}

test('the real Agent HTTP surface authenticates every confirmation and never exposes transcript reads', async () => {
  const fx = fixture();
  const input = fx.input();
  assert.equal((await fx.api('POST', BASE, input, null)).statusCode, 401);
  const created = await fx.api('POST', BASE, input);
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().schema, 'bailing.agent-conversation-audit.v1');
  assert.equal(created.headers['cache-control'], 'no-store');
  const id = created.json().conversation_id;
  const firstEvents = { events: [
    { event_id: 'start', sequence: 1, client_turn_id: 'turn-1', kind: 'turn_start' },
    { event_id: 'user', sequence: 2, client_turn_id: 'turn-1', kind: 'user_message', content: 'COMPLETE_VISIBLE_USER_MESSAGE' },
  ] };
  assert.equal((await fx.api('POST', `${BASE}/${id}/events`, firstEvents)).json().error, 'conversation_audit_not_ready');
  assert.equal((await fx.api('POST', `${BASE}/${id}/confirm`, { session_id: AUDIT_SESSION_B })).statusCode, 400);
  assert.equal((await fx.api('POST', `${BASE}/${id}/confirm`, {}, AUDIT_SESSION_C)).statusCode, 404);
  assert.equal((await fx.api('POST', `${BASE}/${id}/confirm`, {}, AUDIT_SESSION_B)).json().state, 'ready');
  const written = await fx.api('POST', `${BASE}/${id}/events`, firstEvents);
  assert.deepEqual(written.json(), { schema: 'bailing.agent-conversation-audit-ack.v1', conversation_id: id, last_sequence: 2 });
  for (const path of [BASE, `${BASE}/${id}`, `${BASE}/${id}/events`]) {
    const read = await fx.api('GET', path);
    assert.equal(read.statusCode, 404);
    assert.doesNotMatch(read.body, /COMPLETE_VISIBLE_USER_MESSAGE/);
  }
  assert.equal(fx.events.size, 2);
});

test('only an administrator with runs:read can read complete conversation pages', async () => {
  const fx = fixture();
  const created = await fx.api('POST', BASE, fx.input());
  const id = created.json().conversation_id;
  await fx.api('POST', `${BASE}/${id}/confirm`, {}, AUDIT_SESSION_B);
  await fx.api('POST', `${BASE}/${id}/events`, { events: [
    { event_id: 'start', sequence: 1, client_turn_id: 'turn-1', kind: 'turn_start' },
    { event_id: 'user', sequence: 2, client_turn_id: 'turn-1', kind: 'user_message', content: 'ADMIN_ONLY_VISIBLE_TEXT' },
    { event_id: 'end', sequence: 3, client_turn_id: 'turn-1', kind: 'turn_end', status: 'cancelled' },
  ] });
  const admin = async (path: string, principal: Principal) => {
    const res = new Response();
    await handleAdminConversationAuditFor(fx.store, 'GET', path.split('?')[0]!, request('GET', path), res as unknown as ServerResponse, principal);
    return res;
  };
  const path = `/admin/api/conversation-audits/${id}`;
  for (const principal of [
    { kind: 'agent', ...fx.auth() },
    { kind: 'admin', via: 'session', role: 'kb_editor' },
    { kind: 'admin', via: 'session', role: 'admin', permissions: [] },
  ] as Principal[]) {
    const denied = await admin(path, principal);
    assert.equal(denied.statusCode, 403);
    assert.doesNotMatch(denied.body, /ADMIN_ONLY_VISIBLE_TEXT/);
  }
  const viewer: Principal = { kind: 'admin', via: 'session', role: 'viewer' };
  const first = await admin(`${path}?limit=1`, viewer);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().schema, 'bailing.agent-conversation-audit-detail.v1');
  assert.equal(first.json().has_more, true);
  assert.equal(first.json().next_after_sequence, 1);
  const second = await admin(`${path}?limit=1&after_sequence=1`, viewer);
  assert.equal(second.json().events[0].content, 'ADMIN_ONLY_VISIBLE_TEXT');
  assert.equal(second.headers['cache-control'], 'no-store');
  assert.equal((await admin(`${path}?after_sequence=-1`, viewer)).statusCode, 400);
  const listed = await admin('/admin/api/conversation-audits?limit=1', viewer);
  assert.equal(listed.json().items[0].message_count, 1);
  assert.equal(listed.json().items[0].turn_count, 1);
  assert.equal(listed.json().items[0].last_turn_status, 'cancelled');
});

test('missing storage is explicit and unexpected internal errors never expose raw database detail', async () => {
  const fx = fixture();
  const store = fx.deps.configStore!;
  (store as any).agentConversationAudit = undefined;
  assert.equal((await fx.api('POST', BASE, fx.input())).json().error, 'conversation_audit_unavailable');
  (store as any).agentConversationAudit = { create: async () => { throw new Error('PASSWORD_AND_DATABASE_DETAIL_MUST_NOT_LEAK'); } };
  const failure = await fx.api('POST', BASE, fx.input());
  assert.equal(failure.statusCode, 500);
  assert.equal(failure.json().error, 'conversation_audit_internal_error');
  assert.doesNotMatch(failure.body, /PASSWORD|DATABASE_DETAIL/);
});
