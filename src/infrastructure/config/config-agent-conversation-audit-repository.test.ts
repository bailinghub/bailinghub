import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationAuditError, parseConversationAuditEvents } from '../../core/runtime/agent-conversation-audit';
import { conversationAuditFixture, AUDIT_SESSION_A, AUDIT_SESSION_B, AUDIT_SESSION_C, AUDIT_RUN_A, AUDIT_RUN_B } from '../../test-support/agent-conversation-audit-fixture';

const errorCode = (code: string) => (error: unknown) => error instanceof ConversationAuditError && error.code === code;
const events = () => parseConversationAuditEvents({ events: [
  { event_id: 'start-1', sequence: 1, client_turn_id: 'turn-1', kind: 'turn_start' },
  { event_id: 'user-1', sequence: 2, client_turn_id: 'turn-1', kind: 'user_message', content: 'Compare Store A and Store B.\nKeep this full visible request.' },
  { event_id: 'link-a', sequence: 3, client_turn_id: 'turn-1', kind: 'run_link', run_id: AUDIT_RUN_A, member_session_id: AUDIT_SESSION_A },
  { event_id: 'link-b', sequence: 4, client_turn_id: 'turn-1', kind: 'run_link', run_id: AUDIT_RUN_B, member_session_id: AUDIT_SESSION_B },
  { event_id: 'assistant-1', sequence: 5, client_turn_id: 'turn-1', kind: 'assistant_message', content: 'The complete visible answer combines both stores.' },
  { event_id: 'end-1', sequence: 6, client_turn_id: 'turn-1', kind: 'turn_end', status: 'completed' },
] });

test('a frozen group requires the own bearer of each member before accepting any body', async () => {
  const fx = conversationAuditFixture();
  const created = await fx.repo.create(fx.auth(), fx.input());
  assert.equal(created.state, 'enrolling');
  assert.equal(created.confirmed_count, 1);
  assert.equal(fx.events.size, 0);
  await assert.rejects(fx.repo.append(fx.auth(), created.conversation_id, events()), errorCode('conversation_audit_not_ready'));
  await assert.rejects(fx.repo.confirm(fx.auth(AUDIT_SESSION_C), created.conversation_id), errorCode('conversation_audit_not_found'));
  assert.equal(fx.members.get(`${created.conversation_id}:${AUDIT_SESSION_B}`)!.confirmed_at, null);
  const confirmed = await fx.repo.confirm(fx.auth(AUDIT_SESSION_B), created.conversation_id);
  assert.equal(confirmed.state, 'ready');
  assert.equal(confirmed.confirmed_count, 2);
  assert.equal((await fx.repo.confirm(fx.auth(AUDIT_SESSION_B), created.conversation_id)).confirmed_count, 2);
  await assert.rejects(fx.repo.append(fx.auth(AUDIT_SESSION_B), created.conversation_id, events()), errorCode('conversation_audit_not_found'));
  assert.equal(fx.events.size, 0);
});

test('archive creation is creator-scoped and frozen input is idempotent, never joined by bare conversation id', async () => {
  const fx = conversationAuditFixture();
  const created = await fx.repo.create(fx.auth(), fx.input());
  assert.equal((await fx.repo.create(fx.auth(), fx.input())).conversation_id, created.conversation_id);
  await assert.rejects(fx.repo.create(fx.auth(), fx.input({ client_conversation_id: 'another-conversation' })), errorCode('conversation_audit_conflict'));
  await assert.rejects(fx.repo.create(fx.auth(), fx.input({ member_session_ids: [AUDIT_SESSION_A], member_labels: {} })), errorCode('conversation_audit_conflict'));
  const anotherCreator = await fx.repo.create(fx.auth(AUDIT_SESSION_B), fx.input());
  assert.notEqual(anotherCreator.conversation_id, created.conversation_id);
  assert.equal(fx.archives.size, 2);
});

test('full visible events are stored once, paginated without truncation, and linked to the original authorization runs', async () => {
  const fx = conversationAuditFixture();
  const created = await fx.ready();
  const sent = events();
  assert.equal((await fx.repo.append(fx.auth(), created.conversation_id, sent)).last_sequence, 6);
  assert.equal((await fx.repo.append(fx.auth(), created.conversation_id, sent)).last_sequence, 6);
  assert.equal(fx.events.size, 6);
  const first = (await fx.repo.detailForAdmin(created.conversation_id, 0, 2))!;
  assert.equal(first.events[1].content, sent[1]!.content);
  assert.equal(first.has_more, true);
  assert.equal(first.next_after_sequence, 2);
  assert.equal(first.conversation.message_count, 2);
  assert.equal(first.conversation.turn_count, 1);
  assert.equal(first.conversation.last_turn_status, 'completed');
  const second = (await fx.repo.detailForAdmin(created.conversation_id, 2, 2))!;
  assert.deepEqual(second.events.map((event: any) => [event.run_id, event.thread_id]), [[AUDIT_RUN_A, 101], [AUDIT_RUN_B, 102]]);
  assert.deepEqual(await fx.repo.findRunLinkForAdmin(AUDIT_RUN_B), { conversation_audit_id: created.conversation_id, client_turn_id: 'turn-1' });
  const final = (await fx.repo.detailForAdmin(created.conversation_id, 4, 2))!;
  assert.equal(final.has_more, false);
  assert.equal(final.next_after_sequence, 6);
  assert.equal(first.members[0].display_label, 'Store A');
  assert.doesNotMatch(JSON.stringify(first), /identity_hash|enrollment_hash|access_token|refresh_token|context_json/);
  assert.equal(fx.queries.some(({ sql }) => /INSERT INTO bz_messages|UPDATE bz_threads/.test(sql)), false);
  const writeIndex = fx.queries.findIndex(({ sql }) => sql.startsWith('INSERT INTO bz_agent_conversation_events'));
  for (const id of [AUDIT_SESSION_A, AUDIT_SESSION_B]) assert.ok(fx.queries.slice(0, writeIndex).some(({ sql, params, transactional }) => sql.includes('FROM bz_agent_sessions') && sql.includes('FOR UPDATE') && params[0] === id && transactional));
});

test('changed retries, gaps and event-id reuse fail atomically', async () => {
  const fx = conversationAuditFixture();
  const created = await fx.ready();
  const sent = events();
  await fx.repo.append(fx.auth(), created.conversation_id, sent.slice(0, 2));
  await assert.rejects(fx.repo.append(fx.auth(), created.conversation_id, [{ ...sent[1]!, content: 'Changed original message' }]), errorCode('conversation_audit_conflict'));
  await assert.rejects(fx.repo.append(fx.auth(), created.conversation_id, [sent[3]!]), errorCode('conversation_audit_conflict'));
  await assert.rejects(fx.repo.append(fx.auth(), created.conversation_id, [{ ...sent[2]!, event_id: sent[1]!.event_id }]), errorCode('conversation_audit_conflict'));
  await assert.rejects(fx.repo.append(fx.auth(), created.conversation_id, [sent[2]!, { ...sent[3]!, member_session_id: AUDIT_SESSION_C }]), errorCode('conversation_audit_conflict'));
  assert.equal(fx.events.size, 2, 'the valid first event in a failed batch must also roll back');
  assert.equal(fx.archives.get(created.conversation_id)!.last_sequence, 2);
});

for (const field of ['session_id', 'client_app_id', 'route_key', 'client_conversation_id', 'client_turn_id']) {
  test(`run_link rejects a different ${field} instead of widening its frozen ownership`, async () => {
    const fx = conversationAuditFixture();
    const created = await fx.ready();
    fx.runs.get(AUDIT_RUN_A)![field] = field === 'session_id' ? AUDIT_SESSION_C : 'other-binding';
    await assert.rejects(fx.repo.append(fx.auth(), created.conversation_id, events()), errorCode('conversation_audit_conflict'));
    assert.equal(fx.events.size, 0);
  });
}

for (const mutation of ['revoked', 'expired', 'principal', 'subject', 'session-route', 'client-route', 'client-disabled', 'route-disabled', 'audience']) {
  test(`a ${mutation} authorization change blocks all further conversation text`, async () => {
    const fx = conversationAuditFixture();
    const created = await fx.ready();
    const member = fx.sessions.get(AUDIT_SESSION_B)!;
    if (mutation === 'revoked') member.revoked_at = '2026-01-01T00:00:00Z';
    if (mutation === 'expired') member.refresh_expires_at = '2000-01-01T00:00:00Z';
    if (mutation === 'principal') member.principal_json.tenant = 'other-store';
    if (mutation === 'subject') member.on_behalf_of = 'other-subject';
    if (mutation === 'session-route') member.allowed_routes = [];
    if (mutation === 'client-route') fx.client.allowed_routes = [];
    if (mutation === 'client-disabled') fx.client.enabled = false;
    if (mutation === 'route-disabled') fx.route.enabled = false;
    if (mutation === 'audience') fx.route.audience = { enabled: true, tenants: ['store-a'] };
    await assert.rejects(fx.repo.append(fx.auth(), created.conversation_id, events()), errorCode('conversation_audit_authorization_invalid'));
    assert.equal(fx.events.size, 0);
    assert.equal(fx.archives.get(created.conversation_id)!.last_sequence, 0);
  });
}

test('a single run cannot be attributed to two different complete conversation archives', async () => {
  const fx = conversationAuditFixture();
  const first = await fx.ready();
  await fx.repo.append(fx.auth(), first.conversation_id, events());
  const second = await fx.repo.create(fx.auth(), fx.input({ client_archive_id: '323e4567-e89b-42d3-a456-426614174009' }));
  await fx.repo.confirm(fx.auth(AUDIT_SESSION_B), second.conversation_id);
  await assert.rejects(fx.repo.append(fx.auth(), second.conversation_id, events()), errorCode('conversation_audit_conflict'));
  assert.equal(fx.archives.get(second.conversation_id)!.last_sequence, 0);
});

test('late original run evidence may follow turn_end without reopening it or altering a newer turn', async () => {
  const fx = conversationAuditFixture();
  const created = await fx.ready();
  const sent = events();
  await fx.repo.append(fx.auth(), created.conversation_id, [sent[0]!, sent[1]!, { ...sent[5]!, sequence: 3, status: 'cancelled' }]);
  await fx.repo.append(fx.auth(), created.conversation_id, [{ ...sent[2]!, sequence: 4 }]);
  assert.equal(fx.archives.get(created.conversation_id)!.last_turn_status, 'cancelled');
  await fx.repo.append(fx.auth(), created.conversation_id, [{ event_id: 'start-2', sequence: 5, client_turn_id: 'turn-2', kind: 'turn_start' }]);
  await fx.repo.append(fx.auth(), created.conversation_id, [{ ...sent[3]!, sequence: 6 }]);
  assert.equal(fx.archives.get(created.conversation_id)!.last_turn_id, 'turn-2');
  assert.equal(fx.archives.get(created.conversation_id)!.last_turn_status, 'running');
  await assert.rejects(fx.repo.append(fx.auth(), created.conversation_id, [{ ...sent[4]!, sequence: 7 }]), errorCode('conversation_audit_conflict'));
  assert.equal(fx.archives.get(created.conversation_id)!.last_sequence, 6);
});

test('the archive total byte ceiling rejects the whole next batch instead of truncating content', async () => {
  const fx = conversationAuditFixture();
  const created = await fx.ready();
  fx.archives.get(created.conversation_id)!.content_bytes = 16 * 1024 * 1024 - 1;
  await assert.rejects(fx.repo.append(fx.auth(), created.conversation_id, events()), errorCode('conversation_audit_limit'));
  assert.equal(fx.events.size, 0);
  assert.equal(fx.archives.get(created.conversation_id)!.last_sequence, 0);
});
