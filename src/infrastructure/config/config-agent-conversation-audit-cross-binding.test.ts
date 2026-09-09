import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationAuditError, parseConversationAuditEvents } from '../../core/runtime/agent-conversation-audit';
import { conversationAuditFixture, AUDIT_SESSION_A, AUDIT_SESSION_B, AUDIT_SESSION_C, AUDIT_RUN_A, AUDIT_RUN_B } from '../../test-support/agent-conversation-audit-fixture';

const errorCode = (code: string) => (error: unknown) => error instanceof ConversationAuditError && error.code === code;
const events = () => parseConversationAuditEvents({ events: [
  { event_id: 'start', sequence: 1, client_turn_id: 'turn-1', kind: 'turn_start' },
  { event_id: 'user', sequence: 2, client_turn_id: 'turn-1', kind: 'user_message', content: 'Compare the CRM and ERP accounts. Only update the CRM account.' },
  { event_id: 'crm', sequence: 3, client_turn_id: 'turn-1', kind: 'run_link', run_id: AUDIT_RUN_A, member_session_id: AUDIT_SESSION_A },
  { event_id: 'erp', sequence: 4, client_turn_id: 'turn-1', kind: 'run_link', run_id: AUDIT_RUN_B, member_session_id: AUDIT_SESSION_B },
  { event_id: 'reply', sequence: 5, client_turn_id: 'turn-1', kind: 'assistant_message', content: 'The visible reply spans two systems; their execution records remain separate.' },
  { event_id: 'end', sequence: 6, client_turn_id: 'turn-1', kind: 'turn_end', status: 'completed' },
] });

test('cross-app and cross-route members require their own bearer, preserve original runs and deduplicate ACK retries', async () => {
  const fx = conversationAuditFixture({ crossBinding: true });
  const input = fx.crossInput();
  const head = await fx.repo.createCrossBinding(fx.auth(), input);
  assert.equal(head.client_app_id, 'example-business', 'head identifies the writer, never the whole group');
  assert.equal(head.route_key, 'orders');
  assert.equal(head.state, 'enrolling');
  assert.equal(head.confirmed_count, 1);
  await assert.rejects(fx.repo.append(fx.auth(), head.conversation_id, events()), errorCode('conversation_audit_not_ready'));
  await assert.rejects(fx.repo.confirm(fx.auth(AUDIT_SESSION_C), head.conversation_id), errorCode('conversation_audit_not_found'));
  const spoofed = fx.auth(AUDIT_SESSION_A);
  spoofed.session.session_id = AUDIT_SESSION_B;
  await assert.rejects(fx.repo.confirm(spoofed, head.conversation_id), errorCode('conversation_audit_not_found'));
  assert.equal((await fx.repo.confirm(fx.auth(AUDIT_SESSION_B), head.conversation_id)).state, 'ready');
  await assert.rejects(fx.repo.append(fx.auth(AUDIT_SESSION_B), head.conversation_id, events()), errorCode('conversation_audit_not_found'));
  await fx.repo.append(fx.auth(), head.conversation_id, events());
  assert.equal((await fx.repo.append(fx.auth(), head.conversation_id, events())).last_sequence, 6);
  assert.equal(fx.events.size, 6);
  const detail = (await fx.repo.detailForAdmin(head.conversation_id))!;
  assert.deepEqual(detail.members.map((member: any) => [member.session_id, member.client_app_id, member.client_name, member.route_key]), [
    [AUDIT_SESSION_A, 'example-business', 'Example', 'orders'], [AUDIT_SESSION_B, 'example-erp', 'Example ERP', 'inventory'],
  ]);
  assert.deepEqual(detail.events.filter((event: any) => event.kind === 'run_link').map((event: any) => [event.run_id, event.member_session_id, event.thread_id]), [
    [AUDIT_RUN_A, AUDIT_SESSION_A, 101], [AUDIT_RUN_B, AUDIT_SESSION_B, 102],
  ]);
  assert.equal(detail.events[4].content, events()[4]!.content);
  assert.deepEqual(await fx.repo.findRunLinkForAdmin(AUDIT_RUN_B), { conversation_audit_id: head.conversation_id, client_turn_id: 'turn-1' });
  assert.doesNotMatch(JSON.stringify(detail), /identity_hash|access_token|refresh_token|enrollment_hash/);
  assert.equal(fx.queries.some(({ sql }) => /INSERT INTO bz_messages|UPDATE bz_threads|UPDATE bz_agent_client_runs|bz_agent_tool_invocations/.test(sql)), false);
  const firstWrite = fx.queries.findIndex(({ sql }) => sql.startsWith('INSERT INTO bz_agent_conversation_events'));
  const beforeWrite = fx.queries.slice(0, firstWrite);
  for (const id of ['example-business', 'example-erp']) assert.ok(beforeWrite.some(({ sql, params, transactional }) => sql.includes('FROM bz_clients') && params[0] === id && transactional));
  for (const route of ['orders', 'inventory']) assert.ok(beforeWrite.some(({ sql, params, transactional }) => sql.includes('FROM bz_routes') && params[0] === route && transactional));
});

test('v2 retry freezes every member binding and cannot replace a v1 archive', async () => {
  const fx = conversationAuditFixture({ crossBinding: true });
  const original = await fx.repo.createCrossBinding(fx.auth(), fx.crossInput());
  assert.equal((await fx.repo.createCrossBinding(fx.auth(), fx.crossInput({ members: [...fx.crossInput().members].reverse() }))).conversation_id, original.conversation_id);
  for (const patch of [
    { client_conversation_id: 'another-conversation' },
    { members: fx.crossInput().members.map((member) => member.session_id === AUDIT_SESSION_B ? { ...member, route: 'orders' } : member) },
    { members: fx.crossInput().members.map((member) => member.session_id === AUDIT_SESSION_B ? { ...member, label: 'renamed' } : member) },
  ]) await assert.rejects(fx.repo.createCrossBinding(fx.auth(), fx.crossInput(patch)), errorCode('conversation_audit_conflict'));
  const legacy = conversationAuditFixture();
  await legacy.ready();
  await assert.rejects(legacy.repo.createCrossBinding(legacy.auth(), legacy.crossInput()), errorCode('conversation_audit_conflict'));
});

for (const field of ['client_app_id', 'route_key', 'session_id', 'client_conversation_id', 'client_turn_id']) {
  test(`cross-binding run links reject forged ${field} and roll back the entire batch`, async () => {
    const fx = conversationAuditFixture({ crossBinding: true });
    const head = await fx.readyCross();
    fx.runs.get(AUDIT_RUN_B)![field] = field === 'session_id' ? AUDIT_SESSION_A : 'wrong-binding';
    await assert.rejects(fx.repo.append(fx.auth(), head.conversation_id, events()), errorCode('conversation_audit_conflict'));
    assert.equal(fx.events.size, 0);
    assert.equal(fx.archives.get(head.conversation_id)!.last_sequence, 0);
  });
}

for (const mutation of ['revoked', 'expired', 'identity', 'subject', 'session-route', 'client-route', 'client-disabled', 'route-disabled', 'audience']) {
  test(`cross-binding ${mutation} pauses the whole group, including create retries and ACK retries`, async () => {
    const fx = conversationAuditFixture({ crossBinding: true });
    const head = await fx.readyCross();
    await fx.repo.append(fx.auth(), head.conversation_id, events());
    const member = fx.sessions.get(AUDIT_SESSION_B)!;
    if (mutation === 'revoked') member.revoked_at = '2026-01-01T00:00:00Z';
    if (mutation === 'expired') member.refresh_expires_at = '2000-01-01T00:00:00Z';
    if (mutation === 'identity') member.principal_json.tenant = 'changed-tenant';
    if (mutation === 'subject') member.on_behalf_of = 'changed-subject';
    if (mutation === 'session-route') member.allowed_routes = ['orders'];
    if (mutation === 'client-route') fx.clients.get('example-erp')!.allowed_routes = [];
    if (mutation === 'client-disabled') fx.clients.get('example-erp')!.enabled = false;
    if (mutation === 'route-disabled') fx.routes.get('inventory')!.enabled = false;
    if (mutation === 'audience') fx.routes.get('inventory')!.audience = { enabled: true, tenants: ['store-a'] };
    await assert.rejects(fx.repo.createCrossBinding(fx.auth(), fx.crossInput()), errorCode('conversation_audit_authorization_invalid'));
    await assert.rejects(fx.repo.confirm(fx.auth(), head.conversation_id), errorCode('conversation_audit_authorization_invalid'));
    await assert.rejects(fx.repo.append(fx.auth(), head.conversation_id, events()), errorCode('conversation_audit_authorization_invalid'));
    assert.equal(fx.events.size, 6);
  });
}

test('foreign-Hub or forged member bindings never establish an audit group', async () => {
  for (const patch of [{ session_id: '123e4567-e89b-42d3-a456-426614174099' }, { client_app_id: 'example-business' }, { route: 'orders' }]) {
    const fx = conversationAuditFixture({ crossBinding: true });
    const input = fx.crossInput({ members: fx.crossInput().members.map((member) => member.session_id === AUDIT_SESSION_B ? { ...member, ...patch } : member) });
    await assert.rejects(fx.repo.createCrossBinding(fx.auth(), input), errorCode('conversation_audit_authorization_invalid'));
    assert.equal(fx.archives.size, 0);
    assert.equal(fx.members.size, 0);
  }
});

test('058 capability probe fails closed for missing/partial schema while 057 v1 remains usable', async () => {
  const fx = conversationAuditFixture({ schemaReady: false });
  assert.equal(await fx.repo.supportsCrossBindingMembers(), false);
  await assert.rejects(fx.repo.createCrossBinding(fx.auth(), fx.crossInput()), errorCode('conversation_audit_cross_binding_unavailable'));
  assert.equal(fx.archives.size, 0);
  const legacy = await fx.ready();
  await fx.repo.append(fx.auth(), legacy.conversation_id, events());
  assert.equal(fx.events.size, 6);
  const detail = (await fx.repo.detailForAdmin(legacy.conversation_id))!;
  assert.equal(Object.hasOwn(detail.members[0], 'client_app_id'), false, 'legacy records are not relabelled as proven v2 bindings');
  fx.migrationColumns.add('bz_agent_conversation_audits.membership_version');
  assert.equal(await fx.repo.supportsCrossBindingMembers(), false);
});
