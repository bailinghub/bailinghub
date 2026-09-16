import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentTaskControlError, agentTaskHash, assertTaskCanDispatch, assertTaskWriteCapacity, compareTaskStrings,
  normalizeAgentTaskMembers, normalizeAgentTaskPolicy, taskText, taskUuid, transitionAgentTask, validateTaskInvocation,
  type AgentControlledTask, type AgentTaskMemberInput,
} from './agent-task-control';

const SESSION = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const TASK = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-09-16T01:00:00.000Z';
const policy = () => ({ maxWriteCalls: 2, maxConcurrent: 1, expiresAt: null });
const member = (sessionId = SESSION): AgentTaskMemberInput => ({ sessionId, clientAppId: 'example-shop',
  route: 'shop', clientConversationId: 'conversation-1', allowedTools: ['product_update', 'product_lookup'] });
const task = (): AgentControlledTask => ({ taskId: TASK, state: 'active', revision: 3, ledgerSequence: 12,
  policy: policy(), members: [{ ...member(), identityHash: 'a'.repeat(64) }], scopeHash: 'b'.repeat(64),
  writeReserved: 0, writeConsumed: 0, activePermits: 0, createdBy: 'admin-1', createdAt: NOW, updatedAt: NOW });
const rejectsCode = (work: () => unknown, code: string) => assert.throws(work,
  (error) => error instanceof AgentTaskControlError && error.code === code);

test('task policy: no implicit low write limit; zero, bounded and explicitly unlimited remain distinct', () => {
  assert.deepEqual(normalizeAgentTaskPolicy(policy()), policy());
  assert.equal(normalizeAgentTaskPolicy({ ...policy(), maxWriteCalls: 0 }).maxWriteCalls, 0);
  assert.equal(normalizeAgentTaskPolicy({ ...policy(), maxWriteCalls: null }).maxWriteCalls, null);
  for (const invalid of [-1, 0.5, NaN, '120', undefined, Number.MAX_SAFE_INTEGER]) {
    rejectsCode(() => normalizeAgentTaskPolicy({ ...policy(), maxWriteCalls: invalid } as any), 'TASK_INVALID_INPUT');
  }
  for (const invalid of [0, -1, 0.5, '2', null]) {
    rejectsCode(() => normalizeAgentTaskPolicy({ ...policy(), maxConcurrent: invalid } as any), 'TASK_INVALID_INPUT');
  }
});

test('task expiration rejects impossible calendar dates instead of silently extending the deadline', () => {
  for (const expiresAt of ['2026-02-30T12:00:00Z', '2026-02-29T12:00:00Z', '2026-01-01T24:00:00Z',
    '2026-09-16T01:00:00+08:00', '0001-01-01T00:00:00Z', 'invalid']) {
    rejectsCode(() => normalizeAgentTaskPolicy({ ...policy(), expiresAt }), 'TASK_INVALID_INPUT');
  }
  assert.equal(normalizeAgentTaskPolicy({ ...policy(), expiresAt: '2028-02-29T12:00:00.1Z' }).expiresAt,
    '2028-02-29T12:00:00.100Z');
});

test('task members use exact runtime conversation identifiers and independent copies', () => {
  const a = member();
  const b = member('22222222-2222-4222-8222-222222222222');
  const normalized = normalizeAgentTaskMembers([a, b]);
  assert.deepEqual(normalized, normalizeAgentTaskMembers([b, a]));
  assert.deepEqual(normalized.find((item) => item.sessionId === SESSION)!.allowedTools, ['product_lookup', 'product_update']);
  a.allowedTools.push('another_tool'); a.clientConversationId = 'another-conversation';
  assert.equal(normalized.some((item) => item.allowedTools.includes('another_tool')), false);
  for (const clientConversationId of [' conversation-1', 'conversation-1 ', 'é', 'e\u0301', '', 'x\n']) {
    rejectsCode(() => normalizeAgentTaskMembers([{ ...member(), clientConversationId }]), 'TASK_INVALID_INPUT');
  }
});

test('task canonical hashes are independent of locale collation and object insertion order', () => {
  assert.notEqual(compareTaskStrings('é', 'e\u0301'), 0);
  assert.equal(agentTaskHash({ é: 1, 'e\u0301': 2 }), agentTaskHash({ 'e\u0301': 2, é: 1 }));
  assert.notEqual(agentTaskHash({ é: 1 }), agentTaskHash({ 'e\u0301': 1 }));
});

test('task identifiers cannot obtain a second enforcement identity through UUID casing', () => {
  assert.equal(taskUuid(SESSION.toUpperCase()), SESSION);
  assert.equal(normalizeAgentTaskMembers([member(SESSION.toUpperCase())])[0]!.sessionId, SESSION);
  rejectsCode(() => normalizeAgentTaskMembers([member(SESSION), member(SESSION.toUpperCase())]), 'TASK_INVALID_INPUT');
  rejectsCode(() => taskText('\ud800', 128), 'TASK_INVALID_INPUT');
  assert.equal(taskText('admin-😀', 128), 'admin-😀');
});

test('task policy and members reject unsupported limits, unbounded tools and conversation bodies', () => {
  rejectsCode(() => normalizeAgentTaskPolicy({ ...policy(), maxProducts: 10 } as any), 'TASK_INVALID_INPUT');
  rejectsCode(() => normalizeAgentTaskMembers([{ ...member(), accessToken: 'synthetic-credential' } as any]), 'TASK_INVALID_INPUT');
  rejectsCode(() => normalizeAgentTaskMembers([{ ...member(), body: 'Synthetic conversation' } as any]), 'TASK_INVALID_INPUT');
  for (const allowedTools of [[], ['*'], ['product_lookup', 'product_lookup'], ['invalid-tool']]) {
    rejectsCode(() => normalizeAgentTaskMembers([{ ...member(), allowedTools }]), 'TASK_INVALID_INPUT');
  }
});

test('cumulative write availability includes reserved and consumed calls, not only successful calls', () => {
  const current = task(); current.writeReserved = 1; current.writeConsumed = 1;
  rejectsCode(() => assertTaskWriteCapacity(current), 'TASK_WRITE_BUDGET_EXHAUSTED');
  current.writeReserved = 0; assertTaskWriteCapacity(current);
  current.policy.maxWriteCalls = 0;
  rejectsCode(() => assertTaskWriteCapacity(current), 'TASK_WRITE_BUDGET_EXHAUSTED');
  current.policy.maxWriteCalls = null; assertTaskWriteCapacity(current);
});

test('pause, block and cancellation cannot grant new dispatch; expiry does not reset the budget', () => {
  for (const [state, code] of [['paused', 'TASK_PAUSED'], ['blocked', 'TASK_SCOPE_BLOCKED'], ['cancelled', 'TASK_CANCELLED']] as const) {
    rejectsCode(() => assertTaskCanDispatch({ ...task(), state }, NOW), code);
  }
  const current = task(); current.writeConsumed = 1; current.policy.expiresAt = NOW;
  rejectsCode(() => assertTaskCanDispatch(current, NOW), 'TASK_EXPIRED');
  assert.equal(current.writeConsumed, 1);
  current.policy.expiresAt = '2026-09-16T01:00:00.001Z'; assertTaskCanDispatch(current, NOW);
});

test('cancellation is terminal; a blocked task must first be explicitly paused before resume', () => {
  for (const state of ['active', 'paused', 'blocked'] as const) assert.equal(transitionAgentTask(state, 'cancel'), 'cancelled');
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    rejectsCode(() => transitionAgentTask('cancelled', action), 'TASK_CANCELLED');
  }
  rejectsCode(() => transitionAgentTask('blocked', 'resume'), 'TASK_CONTROL_CONFLICT');
  assert.equal(transitionAgentTask(transitionAgentTask('blocked', 'pause'), 'resume'), 'active');
});

test('invocation input requires an explicit trusted read/write classification and exact coordinates', () => {
  const original = { taskId: TASK, sessionId: SESSION, invocationId: 'c'.repeat(64), runId: TASK, jobId: TASK,
    tool: 'product_update', argsHash: 'd'.repeat(64), executionFingerprint: 'e'.repeat(64), readonly: false, approvalRequired: true };
  assert.deepEqual(validateTaskInvocation(original), original);
  rejectsCode(() => validateTaskInvocation({ ...original, readonly: undefined } as any), 'TASK_INVALID_INPUT');
  rejectsCode(() => validateTaskInvocation({ ...original, arguments: { id: 1 } } as any), 'TASK_INVALID_INPUT');
  rejectsCode(() => validateTaskInvocation({ ...original, idempotent: true } as any), 'TASK_INVALID_INPUT');
  rejectsCode(() => validateTaskInvocation({ ...original, invocationId: 'replacement-id' }), 'TASK_INVALID_INPUT');
});
