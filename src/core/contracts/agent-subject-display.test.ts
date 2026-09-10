import assert from 'node:assert/strict';
import test from 'node:test';
import { agentSubjectDisplayView, readAgentSubjectDisplay, validateAgentSubjectDisplay } from './agent-subject-display';

test('subject display is bounded presentation, with explicit missing and no identity inference', () => {
  assert.deepEqual(validateAgentSubjectDisplay({ name: '  Workspace North  ' }), { ok: true, value: { name: 'Workspace North' } });
  assert.deepEqual(agentSubjectDisplayView(undefined), { subject_display: null, subject_display_status: 'missing' });
  assert.deepEqual(agentSubjectDisplayView({ name: 'Company A' }), { subject_display: { name: 'Company A' }, subject_display_status: 'provided' });
  assert.deepEqual(readAgentSubjectDisplay('{"name":"Account A"}'), { name: 'Account A' });
  assert.equal(validateAgentSubjectDisplay({ name: '😀'.repeat(60) }).ok, true);
  assert.equal(validateAgentSubjectDisplay({ name: '😀'.repeat(61) }).ok, false);
  for (const invalid of [{ name: '' }, { name: '  ' }, { name: 7 }, { tenant: 'Account A' }, { name: 'A', secret: 'redacted' },
    { name: 'A', id: 'identity' }, ['Account A'], 'Account A', { name: 'A'.repeat(121) },
    ...['\n', '\t', '\u0000', '\u007f', '\u0085', '\u009f', '\u2028', '\u2029', '\ud800', '\udc00'].map((c) => ({ name: c + 'A' }))]) {
    assert.equal(validateAgentSubjectDisplay(invalid).ok, false);
    assert.deepEqual(agentSubjectDisplayView(invalid), { subject_display: null, subject_display_status: 'missing' });
  }
  assert.equal(readAgentSubjectDisplay('{invalid'), null);
});
