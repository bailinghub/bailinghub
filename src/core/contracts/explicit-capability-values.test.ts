import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileOpenApiTools } from './openapi-tools';

function compile(method: string, capability: Record<string, unknown>) {
  const result = compileOpenApiTools(JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Explicit capability values', version: '1' },
    paths: {
      '/fixture': {
        [method.toLowerCase()]: {
          operationId: 'fixture_operation',
          summary: 'Isolated declaration fixture',
          parameters: [{ name: 'id', in: 'query', schema: { type: 'string' } }],
          'x-agent-capability': { version: 1, enabled: true, scope: 'fixture.operation', ...capability },
        },
      },
    },
  }));
  assert.equal(result.diagnostics.filter(d => d.severity === 'error').length, 0);
  assert.equal(result.tools.length, 1);
  return result.tools[0]!;
}

for (const method of ['GET', 'POST']) {
  for (const readonly of [undefined, false, true]) {
    for (const risk of [undefined, 'low', 'medium', 'high']) {
      test(`ACC explicit values: ${method}, readonly=${readonly}, risk=${risk}`, () => {
        const tool = compile(method, {
          ...(readonly === undefined ? {} : { execution: { readonly } }),
          ...(risk === undefined ? {} : { risk: { level: risk } }),
        });
        const expectedReadonly = readonly ?? (method === 'GET');
        assert.equal(tool.readonly, expectedReadonly);
        assert.equal(tool.risk, risk ?? (expectedReadonly ? 'low' : 'medium'));
      });
    }
  }
  for (const idempotent of [undefined, false, true]) {
    test(`ACC explicit idempotency: ${method}, idempotent=${idempotent}`, () => {
      const tool = compile(method, idempotent === undefined ? {} : { execution: { idempotent } });
      assert.equal(tool.idempotent, idempotent ?? (method === 'GET'));
    });
  }
}

test('Explicit low risk does not erase approval or subject requirements', () => {
  const conditions = [{ param: 'id', op: '==', value: 'review' }];
  const tool = compile('POST', {
    risk: { level: 'low' },
    execution: { readonly: false, idempotent: false },
    approval: { required: true, when: conditions, prompt: 'Review this operation' },
    subject: { required: true },
    audit: { sensitive: true },
  });
  assert.equal(tool.risk, 'low');
  assert.equal(tool.confirmRequired, true);
  assert.deepEqual(tool.confirmWhen, conditions);
  assert.equal(tool.confirmPrompt, 'Review this operation');
  assert.equal(tool.requiresSubject, true);
  assert.equal(tool.sensitive, true);
});
