// Consume actual generator JSON, then exercise the production OpenAPI compiler.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { compileOpenApiTools } from '../src/core/contracts/openapi-tools';

const report = JSON.parse(readFileSync(0, 'utf8'));
assert.equal(report.passed, true, JSON.stringify(report.errors));
assert.equal(report.matrix.length, 24);
assert.equal(report.idempotence.length, 6);
const seen = new Set<string>();
for (const row of [...report.matrix, ...report.idempotence]) {
  const capability = row.capability;
  const result = compileOpenApiTools(JSON.stringify({
    openapi: '3.0.0', info: { title: 'SDK contract fixture', version: '1' },
    paths: { '/fixture': { [row.method.toLowerCase()]: {
      operationId: 'sdk_fixture', summary: 'SDK generated declaration',
      parameters: [{ name: 'record_id', in: 'query', schema: { type: 'integer' } }],
      'x-agent-capability': capability,
    } } },
  }));
  assert.equal(result.tools.length, 1, JSON.stringify(result.diagnostics));
  assert.equal(result.diagnostics.filter(d => d.severity === 'error').length, 0);
  const tool = result.tools[0]!;
  if (Object.hasOwn(row, 'readonly')) {
    seen.add(JSON.stringify([row.method, row.readonly, row.risk]));
    const readonly = row.readonly ?? (row.method === 'GET');
    assert.equal(tool.readonly, readonly);
    assert.equal(tool.risk, row.risk ?? (readonly ? 'low' : 'medium'));
  } else {
    assert.equal(tool.idempotent, row.idempotent ?? (row.method === 'GET'));
  }
}
assert.equal(seen.size, 24, 'Each input combination must be represented once');
console.log(`${report.sdk}: 24 generated declarations + 6 idempotency cases consumed by Core`);
