import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const openapi = JSON.parse(await readFile(resolve(here, 'jeecgboot-user-adapter.openapi.json'), 'utf8'));
const contract = JSON.parse(await readFile(resolve(here, 'adapter-contract.v1.json'), 'utf8'));

const readOperation = openapi.paths['/agent/system/users/{id}']?.get;
const statusOperation = openapi.paths['/agent/system/users/{id}/status']?.put;

assert.equal(openapi.openapi, '3.1.0');
assert.deepEqual(Object.keys(openapi.paths).sort(), [
  '/agent/system/users/{id}',
  '/agent/system/users/{id}/status'
]);
assert.ok(readOperation, 'Read adapter operation is missing.');
assert.ok(statusOperation, 'Status adapter operation is missing.');

const readCapability = readOperation['x-agent-capability'];
assert.equal(readCapability.version, 1);
assert.equal(readCapability.enabled, true);
assert.equal(readCapability.scope, 'system.user.read');
assert.equal(readCapability.risk.level, 'low');
assert.equal(readCapability.subject.required, true);
assert.equal(readCapability.execution.readonly, true);
assert.equal(readCapability.execution.idempotent, true);

const statusCapability = statusOperation['x-agent-capability'];
assert.equal(statusCapability.version, 1);
assert.equal(statusCapability.enabled, true);
assert.equal(statusCapability.scope, 'system.user.status.update');
assert.equal(statusCapability.risk.level, 'high');
assert.equal(statusCapability.subject.required, true);
assert.equal(statusCapability.approval.required, true);
assert.equal(statusCapability.execution.readonly, false);
assert.equal(statusCapability.execution.idempotent, true);
assert.ok(statusCapability.approval.prompt.includes('目标用户编号'));

const statusSchema = openapi.components.schemas.UserStatusUpdate;
assert.equal(statusSchema.additionalProperties, false);
assert.deepEqual(statusSchema.required, ['status']);
assert.deepEqual(statusSchema.properties.status.enum, [1, 2]);

assert.equal(contract.official_upstream_integration, false);
assert.equal(contract.upstream.commit, 'df83f4de76811ea73bf5b37a8fe00cbb59988a1b');
assert.equal(contract.subject.model_controlled, false);
assert.equal(contract.subject.empty_or_unknown, 'deny');
assert.equal(contract.transport.fail_closed, true);
assert.ok(contract.transport.required_headers.includes('X-Bailing-On-Behalf-Of'));
assert.ok(contract.transport.write_required_headers.includes('X-Bailing-Idempotency-Key'));
assert.deepEqual(contract.status_values, { 1: 'normal', 2: 'frozen' });

const readMapping = contract.mappings.find((item) => item.scope === readCapability.scope);
const statusMapping = contract.mappings.find((item) => item.scope === statusCapability.scope);
assert.ok(readMapping, 'Read mapping is missing.');
assert.ok(statusMapping, 'Status mapping is missing.');
assert.equal(readMapping.adapter_operation_id, readOperation.operationId);
assert.equal(statusMapping.adapter_operation_id, statusOperation.operationId);
assert.equal(readMapping.upstream_permission, 'system:user:queryById');
assert.equal(statusMapping.upstream_permission, 'system:user:frozenBatch');
assert.equal(readMapping.upstream_path, '/sys/user/queryById');
assert.equal(statusMapping.upstream_path, '/sys/user/frozenBatch');

for (const endpoint of [
  '/sys/user/listAll',
  '/sys/user/deleteBatch',
  '/sys/user/resetPassword',
  '/sys/user/updatePassword'
]) {
  assert.ok(contract.excluded_endpoints.some((item) => item.path === endpoint), `${endpoint} exclusion is missing.`);
}

for (const invariant of [
  'operator_tenant_membership_is_active',
  'original_jeecg_permission_is_rechecked',
  'target_tenant_membership_is_active',
  'target_user_and_status_are_rechecked_at_execution_time',
  'business_system_remains_final_authority'
]) {
  assert.ok(contract.required_invariants.includes(invariant), `${invariant} is missing.`);
}

const serializedOpenApi = JSON.stringify(openapi);
for (const forbidden of [
  '/sys/user/listAll',
  '/sys/user/frozenBatch',
  'Authorization',
  'Bearer',
  'X-Access-Token',
  'JEECG_TOKEN'
]) {
  assert.ok(!serializedOpenApi.includes(forbidden), `${forbidden} must not appear in the Agent-facing OpenAPI document.`);
}

console.log('PASS: JeecgBoot BailingHub recipe preserves signature, tenant, permission, approval, idempotency, and final-authority boundaries.');
