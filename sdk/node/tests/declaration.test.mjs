import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenApiSpec, param, tool } from '../src/index.mjs';

function capability(method, options) {
  const spec = buildOpenApiSpec({ tools: [tool({
    name: 'serialization_fixture', description: 'Declaration serialization fixture',
    path: '/fixture', scope: 'fixture.write', method,
    params: [param('fixture', { type: 'string' })], ...options,
  })] });
  return JSON.parse(JSON.stringify(spec)).paths['/fixture'][method.toLowerCase()]['x-agent-capability'];
}

for (const method of ['GET', 'POST']) {
  for (const readonly of [undefined, false, true]) {
    for (const risk of [undefined, 'low', 'medium', 'high']) {
      test(`${method}: readonly=${String(readonly)}, risk=${String(risk)}`, () => {
        const options = {};
        if (readonly !== undefined) options.readonly = readonly;
        if (risk !== undefined) options.risk = risk;
        const cap = capability(method, options);
        assert.equal(Object.hasOwn(cap.execution ?? {}, 'readonly'), readonly !== undefined);
        if (readonly !== undefined) assert.equal(cap.execution.readonly, readonly);
        assert.equal(Object.hasOwn(cap, 'risk'), risk !== undefined);
        if (risk !== undefined) assert.equal(cap.risk.level, risk);
        const expectedRisk = risk ?? ((readonly ?? (method === 'GET')) ? 'low' : 'medium');
        const effectiveReadonly = cap.execution?.readonly ?? (method === 'GET');
        const effectiveRisk = cap.risk?.level ?? (effectiveReadonly ? 'low' : 'medium');
        assert.equal(effectiveRisk, expectedRisk);
        assert.equal(cap.version, 1);
      });
    }
  }
  for (const idempotent of [undefined, false, true]) {
    test(`${method}: idempotent=${String(idempotent)}`, () => {
      const cap = capability(method, idempotent === undefined ? {} : { idempotent });
      assert.equal(Object.hasOwn(cap.execution ?? {}, 'idempotent'), idempotent !== undefined);
      if (idempotent !== undefined) assert.equal(cap.execution.idempotent, idempotent);
    });
  }
}
