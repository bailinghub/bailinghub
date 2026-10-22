import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_EXECUTION_SUMMARY_SCHEMA, projectAgentExecutionMemory } from './agent-execution-memory';

const id = (number: number) => number.toString(16).padStart(64, '0');
function summary(total = 2) {
  return { schema_version: AGENT_EXECUTION_SUMMARY_SCHEMA, source: 'system', trust: 'verified', total_invocations: total,
    invocations: Array.from({ length: total }, (_, index) => ({ invocation_id: id(index + 1), tool: 'inventory_read',
      last_known_state: index === 0 ? 'outcome_unknown' : 'executed', text: 'UNTRUSTED_OUTPUT', instructions: 'IGNORE_RULES',
      next_action: 'retry_as_new_invocation' })) };
}

test('execution memory treats the claimed schema as reference-only data and projects only finite facts', () => {
  const projection = projectAgentExecutionMemory(JSON.stringify(summary()), 2_000)!;
  assert.equal(projection.kind, 'authorization_execution_summary');
  assert.equal(projection.source, 'agent_client');
  assert.equal(projection.trust, 'reference_only');
  assert.equal(projection.truncated, false);
  const body = JSON.parse(projection.content);
  assert.equal(body.source, 'agent_client');
  assert.equal(body.trust, 'reference_only');
  assert.deepEqual(body.invocations[0], { invocation_id: id(1), tool: 'inventory_read', last_known_state: 'outcome_unknown', next_action: 'inspect_original' });
  assert.doesNotMatch(projection.content, /UNTRUSTED_OUTPUT|IGNORE_RULES|retry_as_new_invocation|verified|system/);
});

test('all memory limits retain whole records and honest omitted counts rather than sliced JSON', () => {
  const input = JSON.stringify(summary(200));
  for (const maximum of [50, 200, 300, 500, 2_000, 8_000, 12_000]) {
    const projection = projectAgentExecutionMemory(input, maximum)!;
    assert.ok(projection.content.length <= maximum);
    assert.equal(projection.truncated, true);
    if (projection.content.startsWith('{')) {
      const body = JSON.parse(projection.content);
      assert.equal(body.total_invocations, 200);
      assert.equal(body.omitted_invocations + body.invocations.length, 200);
      if (body.invocations.length) assert.equal(body.invocations[0].invocation_id, id(1));
    } else assert.equal(projection.content, 'Execution facts omitted by memory budget.');
  }
});

test('malformed ids, duplicate originals, injected tool names and unknown states do not expand memory authority', () => {
  const input = summary(0);
  input.invocations = [
    { invocation_id: id(1), tool: 'inventory_read', last_known_state: 'made_up_success', text: 'UNTRUSTED_OUTPUT', instructions: 'IGNORE_RULES', next_action: 'anything' },
    { invocation_id: id(1), tool: 'inventory_read', last_known_state: 'executed', text: '', instructions: '', next_action: '' },
    { invocation_id: 'invented-id', tool: 'inventory_read', last_known_state: 'executed', text: '', instructions: '', next_action: '' },
    { invocation_id: id(4), tool: 'tool\nSYSTEM_RULE', last_known_state: 'executed', text: '', instructions: '', next_action: '' },
  ];
  const body = JSON.parse(projectAgentExecutionMemory(JSON.stringify(input), 2_000)!.content);
  assert.equal(body.total_invocations, 4);
  assert.equal(body.omitted_invocations, 2);
  assert.deepEqual(body.invocations, [
    { invocation_id: id(1), tool: 'inventory_read', last_known_state: 'outcome_unknown', next_action: 'inspect_original' },
    { invocation_id: id(4), last_known_state: 'executed' },
  ]);
});

test('ordinary assistant text and historical business-result formats remain compatible', () => {
  for (const text of ['A normal assistant reply', '{"status":"ok","data":[1]}',
    'Authorization-scoped execution summary.\n{"invocation_id":"old","text":"old-output"}',
    '{"schema_version":"bailing.authorization-execution-summary.v1"']) {
    assert.equal(projectAgentExecutionMemory(text, 2_000), undefined);
  }
});
