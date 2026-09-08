import assert from 'node:assert/strict';
import test from 'node:test';
import { auditStatusLabel, groupAuditTurns, mergeAuditEvents } from '../src/components/conversation-audit.ts';

const event = (sequence, kind, overrides = {}) => ({
  event_id: `event-${sequence}`,
  sequence,
  client_turn_id: 'turn-a',
  kind,
  created_at: '2026-09-08T00:00:00.000Z',
  ...overrides,
});

test('groups a turn spanning pages without separating its messages and execution links', () => {
  const first = [event(1, 'turn_start'), event(2, 'user_message', { content: '查询对象' })];
  const second = [
    event(6, 'turn_start', { client_turn_id: 'turn-b' }),
    event(5, 'turn_end', { status: 'completed' }),
    event(3, 'run_link', { run_id: 'run-a', member_session_id: 'session-a', thread_id: 101 }),
    event(4, 'assistant_message', { content: '已查到对象。' }),
  ];
  const merged = mergeAuditEvents(first, second);
  assert.deepEqual(merged.map(({ sequence }) => sequence), [1, 2, 3, 4, 5, 6]);
  const turns = groupAuditTurns(merged);
  assert.deepEqual(turns.map(({ id, sequence }) => ({ id, sequence })), [
    { id: 'turn-a', sequence: 1 }, { id: 'turn-b', sequence: 6 },
  ]);
  assert.deepEqual(turns[0].events.map(({ sequence }) => sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(turns[0].messages.map(({ content }) => content), ['查询对象', '已查到对象。']);
  assert.equal(turns[0].runs[0].run_id, 'run-a');
  assert.equal(turns[0].start.sequence, 1);
  assert.equal(turns[0].end.status, 'completed');
});

test('deduplicates overlapping pages without truncating received text or mutating inputs', () => {
  const content = '完整正文\n'.repeat(20_000);
  const original = Object.freeze(event(2, 'assistant_message', { content }));
  const current = Object.freeze([original]);
  const incoming = Object.freeze([
    Object.freeze(event(2, 'assistant_message')),
    Object.freeze(event(2, 'assistant_message', { content: '短摘要' })),
  ]);
  const merged = mergeAuditEvents(current, incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].content, content);
  assert.equal(groupAuditTurns(merged)[0].messages[0].content, content);
  assert.notEqual(merged[0], original);
  assert.equal(original.content, content);
});

test('preserves each authorization and original trace reference without synthesizing assistant text', () => {
  const links = [
    event(3, 'run_link', { run_id: 'run-a', member_session_id: 'session-a', thread_id: 101, content: 'A 的执行摘要' }),
    event(4, 'run_link', { run_id: 'run-b', member_session_id: 'session-b', thread_id: 102 }),
  ];
  const [turn] = groupAuditTurns(links);
  assert.deepEqual(turn.runs, links);
  assert.deepEqual(turn.messages, []);
  assert.equal(turn.start, undefined);
  assert.equal(turn.end, undefined);
});

test('keeps absent message content undefined and only fills it from an actual message event', () => {
  const message = event(2, 'assistant_message', { content: undefined });
  const link = event(3, 'run_link', { content: '不能替代正文的执行摘要' });
  const [initial] = groupAuditTurns([message, link]);
  assert.equal(initial.messages.length, 1);
  assert.equal(initial.messages[0].content, undefined);
  const merged = mergeAuditEvents([message, link], [event(2, 'assistant_message', { content: '客户端提交的原文' })]);
  assert.equal(groupAuditTurns(merged)[0].messages[0].content, '客户端提交的原文');
  assert.equal(auditStatusLabel('completed'), '已完成');
  assert.equal(auditStatusLabel(undefined), '—');
  assert.equal(auditStatusLabel('constructor'), 'constructor');
});

test('attaches a later-page run link to its ended turn without creating another turn or message', () => {
  const current = [
    event(1, 'turn_start'),
    event(2, 'user_message', { content: '查询演示对象' }),
    event(3, 'assistant_message', { content: '已完成查询。' }),
    event(4, 'turn_end', { status: 'completed' }),
    event(5, 'turn_start', { client_turn_id: 'turn-b' }),
  ];
  const late = event(6, 'run_link', { run_id: 'run-a', member_session_id: 'session-a', thread_id: 101 });
  const turns = groupAuditTurns(mergeAuditEvents(current, [late]));
  assert.deepEqual(turns.map(turn => turn.id), ['turn-a', 'turn-b']);
  assert.equal(turns[0].end.sequence, 4);
  assert.deepEqual(turns[0].runs, [late]);
  assert.equal(turns[0].messages.length, 2);
  assert.deepEqual(turns[0].events.map(item => item.sequence), [1, 2, 3, 4, 6]);
  assert.deepEqual(turns[1].runs, []);
  assert.deepEqual(turns[1].messages, []);
});
