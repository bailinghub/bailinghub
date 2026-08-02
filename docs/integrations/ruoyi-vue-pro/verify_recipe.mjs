import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const openapi = JSON.parse(await readFile(resolve(here, 'ruoyi-vue-pro-trade-adapter.openapi.json'), 'utf8'));
const contract = JSON.parse(await readFile(resolve(here, 'adapter-contract.v1.json'), 'utf8'));

const getOperation = openapi.paths['/agent/trade/after-sales/{id}']?.get;
const refundOperation = openapi.paths['/agent/trade/after-sales/{id}/refund']?.put;

assert.equal(openapi.openapi, '3.1.0');
assert.deepEqual(Object.keys(openapi.paths).sort(), [
  '/agent/trade/after-sales/{id}',
  '/agent/trade/after-sales/{id}/refund'
]);
assert.ok(getOperation, 'Read adapter operation is missing.');
assert.ok(refundOperation, 'Refund adapter operation is missing.');

const readCapability = getOperation['x-agent-capability'];
assert.equal(readCapability.version, 1);
assert.equal(readCapability.enabled, true);
assert.equal(readCapability.scope, 'trade.after-sale.read');
assert.equal(readCapability.risk.level, 'low');
assert.equal(readCapability.subject.required, true);
assert.equal(readCapability.execution.readonly, true);
assert.equal(readCapability.execution.idempotent, true);

const refundCapability = refundOperation['x-agent-capability'];
assert.equal(refundCapability.version, 1);
assert.equal(refundCapability.enabled, true);
assert.equal(refundCapability.scope, 'trade.after-sale.refund');
assert.equal(refundCapability.risk.level, 'high');
assert.equal(refundCapability.subject.required, true);
assert.equal(refundCapability.approval.required, true);
assert.equal(refundCapability.execution.readonly, false);
assert.equal(refundCapability.execution.idempotent, true);
assert.ok(refundCapability.approval.prompt.includes('售后编号'));

assert.equal(contract.official_upstream_integration, false);
assert.equal(contract.subject.model_controlled, false);
assert.equal(contract.subject.empty_or_unknown, 'deny');
assert.equal(contract.transport.fail_closed, true);
assert.ok(contract.transport.required_headers.includes('X-Bailing-On-Behalf-Of'));
assert.ok(contract.transport.write_required_headers.includes('X-Bailing-Idempotency-Key'));

const readMapping = contract.mappings.find((item) => item.scope === readCapability.scope);
const refundMapping = contract.mappings.find((item) => item.scope === refundCapability.scope);
assert.ok(readMapping, 'Read mapping is missing.');
assert.ok(refundMapping, 'Refund mapping is missing.');
assert.equal(readMapping.adapter_operation_id, getOperation.operationId);
assert.equal(refundMapping.adapter_operation_id, refundOperation.operationId);
assert.equal(readMapping.upstream_permission, 'trade:after-sale:query');
assert.equal(refundMapping.upstream_permission, 'trade:after-sale:refund');
assert.equal(readMapping.upstream_path, '/admin-api/trade/after-sale/get-detail');
assert.equal(refundMapping.upstream_path, '/admin-api/trade/after-sale/refund');

assert.ok(contract.excluded_endpoints.some((item) =>
  item.method === 'POST' && item.path === '/admin-api/trade/after-sale/update-refunded'
));
assert.ok(contract.required_invariants.includes('original_ruoyi_permission_is_rechecked'));
assert.ok(contract.required_invariants.includes('business_system_remains_final_authority'));
assert.ok(contract.required_invariants.includes('payment_callback_is_not_exposed_to_agents'));

const serializedOpenApi = JSON.stringify(openapi);
assert.ok(!serializedOpenApi.includes('/admin-api/trade/after-sale/update-refunded'));
assert.ok(!serializedOpenApi.includes('Authorization'));
assert.ok(!serializedOpenApi.includes('Bearer'));

console.log('PASS: RuoYi-Vue-Pro BailingHub recipe keeps signature, subject, permission, approval, idempotency, and business-authority boundaries explicit.');
