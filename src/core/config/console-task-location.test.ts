import assert from 'node:assert/strict';
import test from 'node:test';
import { filterLoadedRuns, patchTaskQuery, readOutboxLocation, readRunFilters, readRunsLocation, RUN_FILTER_STATUSES, runsTabQuery, safeTaskReturnPath } from '../../../web-admin/src/task-page-location';

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
test('loaded job filtering composes exact status and route without searching body text', () => {
  const rows = [
    { id: 'match', status: 'error', route_key: 'orders', created_at: '2026-10-21T00:00:00Z' },
    { id: 'prefix', status: 'error', route_key: 'orders-next', input_preview: 'orders', created_at: '2026-10-21T00:00:00Z' },
    { id: 'body-only', status: 'error', input_preview: 'orders', created_at: '2026-10-21T00:00:00Z' },
    { id: 'wrong-status', status: 'done', route_key: 'orders', created_at: '2026-10-21T00:00:00Z' },
    { id: 'old', status: 'error', route_key: 'orders', created_at: '2026-10-10T00:00:00Z' },
  ];
  const found = filterLoadedRuns(rows, { status: 'error', route: 'orders', period: '24h' }, Date.parse('2026-10-21T10:00:00Z'));
  assert.deepEqual(found.map(row => row.id), ['match']);
  assert.equal(rows.length, 5, 'filtering does not mutate or replace the loaded snapshot');
  assert.deepEqual(filterLoadedRuns(rows, { status: '', route: '', period: 'all' }, 0), rows);
});
test('time windows include their exact boundary and exclude invalid, future, and older timestamps', () => {
  const now = Date.parse('2026-10-21T10:00:00Z');
  const rows = [
    { id: '24h', created_at: new Date(now - 86400000).toISOString() },
    { id: '7d', created_at: new Date(now - 7 * 86400000).toISOString() },
    { id: 'older', created_at: new Date(now - 7 * 86400000 - 1).toISOString() },
    { id: 'future', created_at: new Date(now + 1).toISOString() },
    { id: 'invalid', created_at: 'unknown' },
  ];
  assert.deepEqual(filterLoadedRuns(rows, { status: '', route: '', period: '24h' }, now).map(row => row.id), ['24h']);
  assert.deepEqual(filterLoadedRuns(rows, { status: '', route: '', period: '7d' }, now).map(row => row.id), ['24h', '7d']);
});
