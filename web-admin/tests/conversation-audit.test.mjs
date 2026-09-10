import assert from 'node:assert/strict';
import test from 'node:test';
import { auditMemberContext, auditStatusLabel, groupAuditTurns, mergeAuditEvents } from '../src/components/conversation-audit.ts';
import { fixtureApi } from './conversation-audit.fixture.mjs';

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

test('uses each member system and route independently of the archive writer and shared account labels', () => {
  const writer = { client_app_id: 'fixture-crm', route_key: 'fixture-crm-customers' };
  const account = { display_label: '同名账户', confirmed: true, principal: { id: 'same-id', roles: ['reader'] } };
  const crm = { ...account, session_id: 'session-a', client_app_id: 'fixture-crm', client_name: '示例 CRM', route_key: 'fixture-crm-customers' };
  const erp = { ...account, session_id: 'session-b', client_app_id: 'fixture-erp', client_name: '示例 ERP', route_key: 'fixture-erp-orders' };
  assert.deepEqual(auditMemberContext(crm, writer), { systemLabel: '示例 CRM · fixture-crm', routeLabel: 'fixture-crm-customers', source: 'member' });
  assert.deepEqual(auditMemberContext(erp, writer), { systemLabel: '示例 ERP · fixture-erp', routeLabel: 'fixture-erp-orders', source: 'member' });
});

test('marks old v1 member context as a header fallback without assigning the writer to incomplete or unknown members', () => {
  const writer = { client_app_id: 'fixture-crm', route_key: 'fixture-crm-customers' };
  const legacy = { session_id: 'session-old', display_label: '旧授权', confirmed: true, principal: { id: 'old', roles: [] } };
  assert.deepEqual(auditMemberContext(legacy, writer), { systemLabel: 'fixture-crm', routeLabel: 'fixture-crm-customers', source: 'legacy_header' });
  assert.deepEqual(auditMemberContext({ ...legacy, client_app_id: 'fixture-erp' }, writer), { systemLabel: 'fixture-erp', routeLabel: '未记录', source: 'member' });
  assert.deepEqual(auditMemberContext({ ...legacy, route_key: 'fixture-erp-orders' }, writer), { systemLabel: '未记录', routeLabel: 'fixture-erp-orders', source: 'member' });
  assert.deepEqual(auditMemberContext(undefined, writer), { systemLabel: '未记录', routeLabel: '未记录', source: 'unavailable' });
  assert.equal(auditMemberContext(legacy, null).source, 'unavailable');
});

test('cross-system fixture keeps v1 pagination, missing text, and each original session/run/job back-link', () => {
  const api = path => fixtureApi(new URL(path, 'http://fixture.invalid'));
  const list = api('/admin/api/conversation-audits');
  assert.equal(list.schema, 'bailing.agent-conversation-audit-list.v1');
  const [conversation, history] = list.items;
  const path = `/admin/api/conversation-audits/${conversation.conversation_id}`;
  const first = api(path);
  const second = api(`${path}?after_sequence=${first.next_after_sequence}`);
  assert.equal(first.schema, 'bailing.agent-conversation-audit-detail.v1');
  assert.equal(first.has_more, true);
  assert.equal(first.next_after_sequence, 3);
  assert.equal(second.has_more, false);
  const [turn, missing] = groupAuditTurns(mergeAuditEvents(first.events, second.events));
  assert.equal(turn.runs.length, 2);
  assert.equal(turn.messages.length, 2);
  assert.equal(missing.messages.find(message => message.kind === 'assistant_message').content, undefined);
  const systems = [];
  for (const run of turn.runs) {
    const member = first.members.find(item => item.session_id === run.member_session_id);
    assert.ok(member);
    systems.push(auditMemberContext(member, conversation));
    const original = api(`/admin/api/threads/${run.thread_id}/agent-runs/${run.run_id}/trace`);
    assert.equal(original.run.run_id, run.run_id);
    assert.equal(original.run.thread_id, run.thread_id);
    assert.equal(original.run.conversation_audit_id, conversation.conversation_id);
    assert.equal(original.run.client_turn_id, turn.id);
    const thread = api(`/admin/api/threads/${run.thread_id}`);
    assert.equal(thread.thread.client_name, member.client_name);
    assert.equal(thread.thread.route_name, member.route_key);
    const job = api(`/admin/api/runs/${original.invocations[0].job_id}/trace`).job;
    assert.equal(job.client_app_id, member.client_app_id);
    assert.equal(job.thread_id, run.thread_id);
    assert.equal(job.conversation_audit_id, conversation.conversation_id);
    assert.equal(job.client_turn_id, turn.id);
  }
  assert.notEqual(systems[0].systemLabel, systems[1].systemLabel);
  assert.notEqual(systems[0].routeLabel, systems[1].routeLabel);
  const old = api(`/admin/api/conversation-audits/${history.conversation_id}`);
  assert.equal(old.members[0].client_app_id, undefined);
  assert.equal(auditMemberContext(old.members[0], old.conversation).source, 'legacy_header');
});
