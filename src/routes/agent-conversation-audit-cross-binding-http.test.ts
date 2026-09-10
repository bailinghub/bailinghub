import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationAuditHttpFixture } from '../test-support/agent-conversation-audit-http-fixture';
import { AUDIT_SESSION_A, AUDIT_SESSION_B, AUDIT_SESSION_C, AUDIT_RUN_A, AUDIT_RUN_B } from '../test-support/agent-conversation-audit-fixture';

const BASE = '/agent-api/v1/conversation-audits';
const events = { events: [
  { event_id: 'start', sequence: 1, client_turn_id: 'turn-1', kind: 'turn_start' },
  { event_id: 'user', sequence: 2, client_turn_id: 'turn-1', kind: 'user_message', content: 'Compare the CRM and ERP accounts. Keep their execution identities separate.' },
  { event_id: 'crm', sequence: 3, client_turn_id: 'turn-1', kind: 'run_link', run_id: AUDIT_RUN_A, member_session_id: AUDIT_SESSION_A },
  { event_id: 'erp', sequence: 4, client_turn_id: 'turn-1', kind: 'run_link', run_id: AUDIT_RUN_B, member_session_id: AUDIT_SESSION_B },
  { event_id: 'answer', sequence: 5, client_turn_id: 'turn-1', kind: 'assistant_message', content: '完整可见答复：CRM 与 ERP 的结果在原授权执行记录中核对。' },
  { event_id: 'end', sequence: 6, client_turn_id: 'turn-1', kind: 'turn_end', status: 'completed' },
] };

test('loopback HTTP preserves a non-first writer, cross-App/route proofs, body permissions and ACK idempotency', async (t) => {
  const fx = await conversationAuditHttpFixture({ crossBinding: true });
  t.after(() => fx.close());
  const a = fx.tokens.get(AUDIT_SESSION_A)!;
  const b = fx.tokens.get(AUDIT_SESSION_B)!;
  const capabilities = await fx.api('GET', `${BASE}/capabilities`, undefined, b);
  assert.deepEqual(capabilities.body, { schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' });
  assert.equal(capabilities.headers.get('cache-control'), 'no-store');
  assert.equal((await fx.api('GET', `${BASE}/capabilities`, undefined, null)).status, 401);
  const created = await fx.api('POST', BASE, fx.crossInput(), b);
  assert.equal(created.status, 200);
  const id = created.body.conversation_id;
  assert.equal(created.body.client_app_id, 'example-erp', 'writer is the bearer member, not lexicographically first A');
  assert.equal(created.body.route_key, 'inventory');
  assert.equal(fx.archives.get(id)!.creator_session_id, AUDIT_SESSION_B);
  assert.equal((await fx.api('POST', `${BASE}/${id}/events`, events, b)).body.error, 'conversation_audit_not_ready');
  assert.equal((await fx.api('POST', `${BASE}/${id}/confirm`, { session_id: AUDIT_SESSION_A }, b)).status, 400);
  assert.equal((await fx.api('POST', `${BASE}/${id}/confirm`, {}, fx.tokens.get(AUDIT_SESSION_C)!)).status, 404);
  assert.equal((await fx.api('POST', `${BASE}/${id}/confirm`, {}, a)).body.state, 'ready');
  assert.equal((await fx.api('POST', `${BASE}/${id}/events`, events, a)).status, 404, 'a member cannot impersonate the writer');
  const ack = await fx.api('POST', `${BASE}/${id}/events`, events, b);
  assert.equal(ack.status, 200);
  assert.deepEqual((await fx.api('POST', `${BASE}/${id}/events`, events, b)).body, ack.body);
  assert.equal(fx.events.size, 6);
  for (const token of [a, fx.deniedAdminToken]) {
    const denied = await fx.api('GET', `/admin/api/conversation-audits/${id}`, undefined, token);
    assert.equal(denied.status, 403);
    assert.doesNotMatch(denied.text, /完整可见答复|Compare the CRM/);
  }
  assert.equal((await fx.api('GET', `${BASE}/${id}`, undefined, b)).status, 404);
  const first = await fx.api('GET', `/admin/api/conversation-audits/${id}?limit=3`, undefined, fx.adminToken);
  const second = await fx.api('GET', `/admin/api/conversation-audits/${id}?limit=3&after_sequence=${first.body.next_after_sequence}`, undefined, fx.adminToken);
  assert.equal(first.body.has_more, true);
  assert.equal(second.body.has_more, false);
  assert.equal(second.headers.get('cache-control'), 'no-store');
  assert.deepEqual(first.body.members.map((member: any) => [member.session_id, member.client_app_id, member.route_key]), [
    [AUDIT_SESSION_A, 'example-business', 'orders'], [AUDIT_SESSION_B, 'example-erp', 'inventory'],
  ]);
  const received = [...first.body.events, ...second.body.events];
  assert.equal(received[1].content, events.events[1]!.content);
  assert.equal(received[4].content, events.events[4]!.content);
  assert.deepEqual(received.filter((event: any) => event.kind === 'run_link').map((event: any) => [event.run_id, event.thread_id]), [[AUDIT_RUN_A, 101], [AUDIT_RUN_B, 102]]);
  assert.deepEqual(await fx.repo.findRunLinkForAdmin(AUDIT_RUN_A), { conversation_audit_id: id, client_turn_id: 'turn-1' });
  assert.equal(first.body.conversation.message_count, 2);
  assert.equal(first.body.conversation.turn_count, 1);
  fx.sessions.get(AUDIT_SESSION_A)!.revoked_at = '2026-01-01T00:00:00Z';
  assert.equal((await fx.api('POST', `${BASE}/${id}/events`, events, b)).status, 403, 'even an ACK retry must revalidate all members');
  assert.equal(fx.events.size, 6);
  assert.equal(fx.requests.some((request) => request.path.includes('/tools/')), false);
});

test('loopback HTTP rejects forged App/route and cross-member run links before storing any text', async (t) => {
  const fx = await conversationAuditHttpFixture({ crossBinding: true });
  t.after(() => fx.close());
  for (const patch of [{ client_app_id: 'example-business' }, { route: 'orders' }]) {
    const input = fx.crossInput({ members: fx.crossInput().members.map((member) => member.session_id === AUDIT_SESSION_B ? { ...member, ...patch } : member) });
    assert.equal((await fx.api('POST', BASE, input)).status, 403);
    assert.equal(fx.archives.size, 0);
  }
  const id = (await fx.api('POST', BASE, fx.crossInput())).body.conversation_id;
  await fx.api('POST', `${BASE}/${id}/confirm`, {}, fx.tokens.get(AUDIT_SESSION_B)!);
  const forged = structuredClone(events);
  forged.events[3]!.member_session_id = AUDIT_SESSION_A;
  assert.equal((await fx.api('POST', `${BASE}/${id}/events`, forged)).status, 409);
  assert.equal(fx.events.size, 0);
});

for (const options of [{ schemaReady: false }, { legacyHost: true }]) {
  test(`loopback HTTP advertises no cross binding for ${options.legacyHost ? 'old Host adapter' : 'pre-058 schema'} while v1 continues`, async (t) => {
    const fx = await conversationAuditHttpFixture(options);
    t.after(() => fx.close());
    assert.equal((await fx.api('GET', `${BASE}/capabilities`)).body.cross_binding_members, false);
    const rejected = await fx.api('POST', BASE, fx.crossInput());
    assert.equal(rejected.status, 503);
    assert.equal(rejected.body.error, 'conversation_audit_cross_binding_unavailable');
    assert.equal(fx.archives.size, 0);
    const created = await fx.api('POST', BASE, fx.input());
    assert.equal(created.body.schema, 'bailing.agent-conversation-audit.v1');
    const id = created.body.conversation_id;
    assert.equal((await fx.api('POST', `${BASE}/${id}/confirm`, {}, fx.tokens.get(AUDIT_SESSION_B)!)).body.state, 'ready');
    assert.equal((await fx.api('POST', `${BASE}/${id}/events`, events)).status, 200);
    const detail = await fx.api('GET', `/admin/api/conversation-audits/${id}`, undefined, fx.adminToken);
    assert.equal(detail.body.events.length, 6);
    assert.equal(Object.hasOwn(detail.body.members[0], 'client_app_id'), false);
  });
}

test('capability discovery requires an explicit true Host result and does not disguise storage errors as support', async (t) => {
  const fx = await conversationAuditHttpFixture();
  t.after(() => fx.close());
  fx.deps.configStore = { ...fx.store, agentConversationAudit: undefined };
  assert.equal((await fx.api('GET', `${BASE}/capabilities`)).body.cross_binding_members, false);
  fx.deps.configStore = fx.store;
  const probe = fx.repo.supportsCrossBindingMembers;
  for (const unsupported of [false, undefined, null, 'true', 1]) {
    fx.repo.supportsCrossBindingMembers = async () => unsupported as boolean;
    assert.equal((await fx.api('GET', `${BASE}/capabilities`)).body.cross_binding_members, false);
    assert.equal((await fx.api('POST', BASE, fx.crossInput())).status, 503);
    assert.equal(fx.archives.size, 0);
  }
  fx.repo.supportsCrossBindingMembers = async () => { throw new Error('SYNTHETIC_PRIVATE_STORAGE_DETAIL'); };
  const failure = await fx.api('GET', `${BASE}/capabilities`);
  assert.equal(failure.status, 503);
  assert.equal(failure.body.error, 'conversation_audit_unavailable');
  assert.doesNotMatch(failure.text, /PRIVATE_STORAGE/);
  fx.repo.supportsCrossBindingMembers = probe;
});
