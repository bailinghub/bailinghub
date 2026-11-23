import assert from 'node:assert/strict';
import test from 'node:test';
import { jobStatusLabel } from '../../../web-admin/src/task-trace-presentation';
import { runFilterParams, patchTaskQuery, readOutboxLocation, readRunFilters, readRunsLocation, RUN_FILTER_STATUSES, runsTabQuery, safeTaskReturnPath } from '../../../web-admin/src/task-page-location';

test('task tabs restore canonical and legacy links without a job stealing an explicit delivery tab', () => {
  assert.equal(readRunsLocation({ tab: 'outbox', job: 'original' }).tab, 'notifications');
  assert.equal(readRunsLocation({ tab: 'notifications' }).tab, 'notifications');
  assert.equal(readRunsLocation({ job: 'original' }).detail, 'original');
  assert.equal(readRunsLocation({ tab: 'jobs', job: 'original' }).detail, '');
  assert.equal(runsTabQuery('threads'), 'conversations');
  const restored = readRunsLocation({ tab: 'conversations', view: 'legacy', thread: '42', thread_q: 'customer', detail: 'job-detail' });
  assert.deepEqual([restored.tab, restored.view, restored.thread, restored.threadQ, restored.detail], ['threads', 'legacy', 42, 'customer', 'job-detail']);
});
test('changing a task selection preserves unrelated filters and the diagnostic return context', () => {
  const original = { task: 'old', invocation: 'old-call', return_to: '/diagnostics?section=delivery', future: ['one', 'two'], outbox_status: 'uncertain' };
  const next = patchTaskQuery(original, { task: 'new', invocation: undefined });
  assert.equal(next.task, 'new'); assert.equal(next.invocation, undefined);
  assert.equal(next.return_to, original.return_to); assert.deepEqual(next.future, ['one', 'two']);
  assert.equal(original.invocation, 'old-call');
});
test('outbox filter restoration validates enums and pagination without coercing malformed query arrays', () => {
  assert.deepEqual(readOutboxLocation({ outbox_kind: 'delivery-dlq', outbox_status: 'uncertain', outbox_page: '3' }), { kind: 'delivery-dlq', status: 'uncertain', page: 3 });
  assert.deepEqual(readOutboxLocation({ outbox_kind: ['delivery'], outbox_status: 'new-state', outbox_page: '-4' }), { kind: 'callback', status: '', page: 1 });
  assert.equal(readOutboxLocation({ outbox_page: '9007199254740992' }).page, 1);
});
test('return context only navigates to known pages inside this console', () => {
  assert.equal(safeTaskReturnPath('/diagnostics?section=delivery#results'), '/diagnostics?section=delivery#results');
  assert.equal(safeTaskReturnPath('/agent-tasks?task=original'), '/agent-tasks?task=original');
  assert.equal(safeTaskReturnPath('/executors?focus=worker-1&q=orders'), '/executors?focus=worker-1&q=orders');
  for (const value of ['https://evil.example/runs', '//evil.example/runs', '/\\evil.example/runs', 'javascript:alert(1)', '/admin/api/runs', '/runs/../../login', '/%2f%2fevil.example', '/runs\n', ['/runs']]) assert.equal(safeTaskReturnPath(value), undefined);
});
test('job filters accept the actual job status contract and keep diagnostic and selection context', () => {
  assert.deepEqual([...RUN_FILTER_STATUSES], ['queued', 'running', 'dispatched', 'done', 'error', 'rejected']);
  assert.deepEqual(readRunFilters({ run_status: 'error', run_route: 'orders', run_period: '24h' }), { status: 'error', route: 'orders', period: '24h' });
  assert.deepEqual(readRunFilters({ run_status: 'failed', run_route: ['orders'], run_period: '2d' }), { status: '', route: '', period: 'all' });
  const query = patchTaskQuery({ detail: 'original-job', return_to: '/diagnostics', future: 'kept', run_status: 'queued' }, { tab: 'jobs', run_status: undefined, run_route: 'orders', run_period: '7d' });
  assert.deepEqual(readRunFilters(query), { status: '', route: 'orders', period: '7d' });
  assert.equal(query.detail, 'original-job'); assert.equal(query.return_to, '/diagnostics'); assert.equal(query.future, 'kept');
});
test('dispatch filters are sent to the server, including routes outside the loaded page', () => {
  const filters = readRunFilters({ run_status: 'error', run_route: 'orders & returns', run_period: '24h' });
  assert.deepEqual(Object.fromEntries(runFilterParams(filters)), { status: 'error', route_key: 'orders & returns', period: '24h' });
  assert.equal(runFilterParams(readRunFilters({})).toString(), '');
  assert.deepEqual(Object.fromEntries(runFilterParams(readRunFilters({ run_period: '7d' }))), { period: '7d' });
});

test('job status labels cover the job lifecycle and preserve unknown raw values', () => {
  assert.deepEqual(RUN_FILTER_STATUSES.map(jobStatusLabel), ['等待执行', '执行中', '已派发', '已完成', '执行错误', '已拒绝']);
  for (const status of [undefined, null, ' ', '']) assert.equal(jobStatusLabel(status), '未记录');
  for (const status of ['paused', 'completed', 'constructor', 'toString', '__proto__']) assert.equal(jobStatusLabel(status), status);
});
