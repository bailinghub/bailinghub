import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationAuditError, parseCreateConversationAudit, parseCreateCrossBindingConversationAudit, parseConversationAuditEvents } from './agent-conversation-audit';
import { conversationAuditFixture, AUDIT_SESSION_A } from '../../test-support/agent-conversation-audit-fixture';

test('visible text preserves original characters and refuses undeclared reasoning or identity fields', () => {
  const event = { event_id: 'visible-1', sequence: 1, client_turn_id: 'turn-1', kind: 'user_message', content: '  原始文本\n<tool>quoted</tool>  ' };
  assert.equal(parseConversationAuditEvents({ events: [event] })[0]!.content, event.content);
  for (const invalid of [
    { ...event, reasoning: 'not visible' }, { ...event, token: 'not allowed' },
    { ...event, member_session_id: AUDIT_SESSION_A }, { ...event, content: '\u0000' },
    { ...event, content: ' ' }, { ...event, content: 'a'.repeat(64_001) },
    { ...event, kind: 'tool_result' }, { ...event, sequence: 0 },
  ]) assert.throws(() => parseConversationAuditEvents({ events: [invalid] }), (error: unknown) => error instanceof ConversationAuditError && error.statusCode === 400);
});

test('membership accepts all 64 host scope slots and rejects duplicate or unbound display labels', () => {
  const fx = conversationAuditFixture();
  const ids = Array.from({ length: 64 }, (_, index) => `123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`);
  assert.equal(parseCreateConversationAudit({ ...fx.input(), member_session_ids: ids, member_labels: {} }).member_session_ids.length, 64);
  for (const patch of [
    { member_session_ids: [AUDIT_SESSION_A, AUDIT_SESSION_A] },
    { member_labels: { '123e4567-e89b-42d3-a456-426614174099': 'An unselected member' } },
    { member_labels: { [AUDIT_SESSION_A]: 'x'.repeat(129) } },
    { tenant: 'client-supplied-audit-scope' },
  ]) assert.throws(() => parseCreateConversationAudit({ ...fx.input(), ...patch }));
});

test('event batches enforce continuity, unique ids and explicit byte or total-event limits', () => {
  const event = { event_id: 'visible', sequence: 1, client_turn_id: 'turn-1', kind: 'assistant_message', content: 'a' };
  assert.throws(() => parseConversationAuditEvents({ events: [event, { ...event, event_id: 'next', sequence: 3 }] }));
  assert.throws(() => parseConversationAuditEvents({ events: [event, { ...event, sequence: 2 }] }));
  assert.throws(() => parseConversationAuditEvents({ events: Array.from({ length: 51 }, (_, index) => ({ ...event, event_id: `event-${index}`, sequence: index + 1 })) }));
  for (const batch of [
    [{ ...event, sequence: 20_001 }],
    Array.from({ length: 5 }, (_, index) => ({ ...event, event_id: `large-${index}`, sequence: index + 1, content: 'a'.repeat(64_000) })),
  ]) assert.throws(() => parseConversationAuditEvents({ events: batch }), (error: unknown) => error instanceof ConversationAuditError && error.code === 'conversation_audit_limit' && error.statusCode === 413);
});

test('cross-binding membership is explicit, canonical and cannot reuse one Session for two routes', () => {
  const fx = conversationAuditFixture({ crossBinding: true });
  const input = fx.crossInput();
  assert.deepEqual(parseCreateCrossBindingConversationAudit({ ...input, members: [...input.members].reverse() }), input);
  for (const patch of [
    { schema: 'bailing.agent-conversation-audit-create.v1' },
    { route: 'orders' }, { hub_url: 'https://other-hub.example.com' },
    { member_session_ids: [AUDIT_SESSION_A] }, { members: [] },
    { members: [input.members[0], { ...input.members[0], route: 'inventory' }] },
    { members: [{ ...input.members[0], client_app_id: 'WRONG_CASE' }] },
    { members: [{ ...input.members[0], route: 'auto' }] },
    { members: [{ ...input.members[0], label: 'x'.repeat(129) }] },
    { members: [{ ...input.members[0], access_token: 'never permitted' }] },
  ]) assert.throws(() => parseCreateCrossBindingConversationAudit({ ...input, ...patch }),
    (error: unknown) => error instanceof ConversationAuditError && error.statusCode === 400);
  assert.throws(() => parseCreateConversationAudit(input), 'old v1 must never infer a wider membership');
});
