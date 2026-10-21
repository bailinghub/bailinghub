import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnosticDestination, filterLocatedRows, readListLocation } from '../../../web-admin/src/console-location';

test('diagnostics distinguish configuration objects from runtime aggregates and preserve return context', () => {
  const origin = '/diagnostics?severity=error&q=demo';
  assert.deepEqual(diagnosticDestination({ area: 'tool_provider', id: 'demo' }, origin), { path: '/tools', query: { q: 'demo', focus: 'demo', return_to: origin } });
  assert.equal(diagnosticDestination({ area: 'alert_rule', id: '12' }, origin)?.query.alert_focus, '12');
  assert.equal(diagnosticDestination({ area: 'runtime_jobs', id: 'error_burst' }, origin)?.query.tab, 'jobs');
  assert.equal(diagnosticDestination({ area: 'runtime_delivery', id: 'delivery_dlq' }, origin)?.query.outbox_kind, 'delivery-dlq');
  assert.equal(diagnosticDestination({ area: 'runtime_executor', id: 'offline' }, origin)?.query.state, 'offline');
  assert.equal(diagnosticDestination({ area: 'runtime_executor', id: 'worker-a' }, origin)?.query.target, 'worker-a');
  assert.equal(diagnosticDestination({ area: 'new-unknown-area', id: 'something' }, origin), undefined);
});
test('exact diagnostic focus cannot silently select a similar object or match secrets', () => {
  const rows = [{ id: 'a', name: 'Alpha', secret: 'token-value' }, { id: 'aa', name: 'Beta', secret: '' }];
  const filter = (q: string, focus = '') => filterLocatedRows(rows, q, focus, r => r.id, r => `${r.id} ${r.name}`);
  assert.deepEqual(filter('a', 'a'), [rows[0]]);
  assert.deepEqual(filter('', 'deleted'), []);
  assert.deepEqual(filter('TOKEN-VALUE'), []);
  assert.deepEqual(filter('alpha'), [rows[0]]);
  assert.deepEqual(readListLocation({ q: ['bad'], focus: null }), { keyword: '', focus: '' });
  assert.deepEqual(readListLocation({ alert_q: '12', alert_focus: '12' }, 'alert_'), { keyword: '12', focus: '12' });
});

test('auto-routing diagnostics locate a client or both ambiguous routes rather than treating aggregate IDs as route keys', () => {
  const origin = '/diagnostics?tab=auto';
  const noCandidates = diagnosticDestination({ area: 'route_auto', id: 'client-a' }, origin);
  assert.equal(noCandidates?.path, '/clients');
  assert.equal(noCandidates?.query.focus, 'client-a');
  const ambiguous = diagnosticDestination({ area: 'route_auto', id: 'route-a<->route-b' }, origin);
  assert.deepEqual(ambiguous, { path: '/routes', query: { return_to: origin, q: 'route-a', focus: 'route-a', related: 'route-b' } });
  assert.deepEqual(filterLocatedRows(['route-a', 'route-b', 'route-aa'], 'route-a', 'route-a', r => r, r => r, 'route-b'), ['route-a', 'route-b']);
  assert.equal(diagnosticDestination({ area: 'route_auto', id: 'a<->b<->c' }, origin), undefined);
  assert.equal(diagnosticDestination({ area: 'credential', id: 'model-key' }, origin)?.path, '/credentials');
});
