import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITION_SCHEMA_VERSION, hasToolDefinitionErrors, validateToolDefinition, type ToolDefinition } from './tool-definition';

const schemaPath = new URL('../../../schemas/tool-definition.schema.json', import.meta.url);

test('ToolDefinition JSON Schema: 版本和关键字段与代码契约对齐', () => {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as any;

  assert.equal(schema.properties.schemaVersion.const, TOOL_DEFINITION_SCHEMA_VERSION);
  assert.deepEqual(schema.properties.source.enum, ['openapi', 'overlay', 'sdk', 'mcp', 'manual']);
  assert.deepEqual(schema.properties.risk.enum, ['low', 'medium', 'high']);
  assert.deepEqual(schema.properties.paramIn.additionalProperties.enum, ['query', 'body', 'path', 'header']);
  assert.deepEqual(schema.$defs.confirmCondition.properties.op.enum, ['>', '>=', '<', '<=', '==', '!=', 'in', 'contains', 'exists']);
  assert.deepEqual(schema.$defs.rateLimit.properties.window.enum, ['1s', '1m', '1h', '1d']);
  assert.deepEqual(schema.$defs.outcome.properties.sideEffect.enum, ['none', 'read', 'write', 'notify', 'external']);
  assert.equal(schema.properties.timeoutMs.maximum, 600000);

  for (const field of ['schemaVersion', 'name', 'source', 'method', 'path', 'description', 'scope', 'risk', 'inputSchema', 'paramIn']) {
    assert.ok(schema.required.includes(field), `${field} should be required`);
  }
});

test('ToolDefinition JSON Schema: 编译诊断 compileResult 已标准化', () => {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as any;

  assert.deepEqual(schema.$defs.diagnostic.properties.severity.enum, ['error', 'warning', 'info']);
  assert.deepEqual(schema.$defs.compileResult.required, ['tools', 'diagnostics']);
  assert.equal(schema.$defs.compileResult.properties.tools.items.$ref, '#');
  assert.equal(schema.$defs.compileResult.properties.diagnostics.items.$ref, '#/$defs/diagnostic');
});

function validTool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    schemaVersion: TOOL_DEFINITION_SCHEMA_VERSION,
    name: 'staff_get',
    source: 'manual',
    method: 'GET',
    path: '/stores/{store_id}/staff',
    description: '查询门店员工',
    scope: 'tenant.staff.read',
    risk: 'low',
    confirmRequired: false,
    rateLimitPerMin: 0,
    rateLimit: { count: 60, window: '1m' },
    requiresSubject: true,
    sensitive: false,
    readonly: true,
    idempotent: true,
    timeoutMs: 0,
    confirmPrompt: '',
    context: [],
    outcome: { result: '返回员工列表', sideEffect: 'read' },
    extensions: {},
    inputSchema: {
      type: 'object',
      properties: {
        store_id: { type: 'string', description: '门店 ID' },
        keyword: { type: 'string', description: '搜索词' },
        amount: { type: 'number', description: '金额' },
      },
      required: ['store_id'],
    },
    paramIn: { store_id: 'path', keyword: 'query' },
    ...over,
  };
}

test('validateToolDefinition: 合法工具无 error diagnostics', () => {
  const diagnostics = validateToolDefinition(validTool());

  assert.equal(hasToolDefinitionErrors(diagnostics), false);
  assert.deepEqual(diagnostics, []);
});

test('validateToolDefinition: ACC 单工具超时支持 10 分钟并拒绝超界值', () => {
  assert.equal(hasToolDefinitionErrors(validateToolDefinition(validTool({ timeoutMs: 600000 }))), false);
  assert.ok(validateToolDefinition(validTool({ timeoutMs: 600001 }))
    .some((d) => d.severity === 'error' && d.code === 'invalid_timeout'));
});

test('validateToolDefinition: 拦截坏契约并给出稳定诊断码', () => {
  const diagnostics = validateToolDefinition(validTool({
    schemaVersion: 'old' as typeof TOOL_DEFINITION_SCHEMA_VERSION,
    name: 'bad-name',
    method: 'post',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
      },
      required: ['store_id'],
    },
    paramIn: { store_id: 'path', orphan: 'query' },
  }));

  assert.equal(hasToolDefinitionErrors(diagnostics), true);
  assert.ok(diagnostics.some((d) => d.severity === 'error' && d.code === 'invalid_schema_version'));
  assert.ok(diagnostics.some((d) => d.severity === 'error' && d.code === 'invalid_name'));
  assert.ok(diagnostics.some((d) => d.severity === 'error' && d.code === 'invalid_method'));
  assert.ok(diagnostics.some((d) => d.severity === 'error' && d.code === 'required_param_missing_schema' && d.message.includes('store_id')));
  assert.ok(diagnostics.some((d) => d.severity === 'error' && d.code === 'param_location_without_schema' && d.message.includes('orphan')));
});

test('validateToolDefinition: 扩展命名空间错误只警告，不阻断工具', () => {
  const diagnostics = validateToolDefinition(validTool({
    extensions: {
      owner: 'trade-team',
      'x-business-owner': 'trade-team',
    },
  }));

  assert.equal(hasToolDefinitionErrors(diagnostics), false);
  assert.ok(diagnostics.some((d) => d.severity === 'warning' && d.code === 'extension_namespace' && d.message.includes('owner')));
});

test('validateToolDefinition: 参数级确认规则校验', () => {
  const ok = validateToolDefinition(validTool({
    confirmWhen: [{ param: 'amount', op: '>', value: 1000, label: '大额退款' }],
  }));
  assert.equal(hasToolDefinitionErrors(ok), false);

  const bad = validateToolDefinition(validTool({
    confirmWhen: [{ param: 'amount', op: '>', label: '漏 value' } as any],
  }));
  assert.ok(bad.some((d) => d.severity === 'error' && d.code === 'invalid_confirm_when_value'));
});

test('validateToolDefinition: 参数级确认必须引用有类型的已声明参数', () => {
  const missing = validateToolDefinition(validTool({
    confirmWhen: [{ param: 'missing', op: '==', value: true }],
  }));
  assert.ok(missing.some((d) => d.severity === 'error' && d.code === 'confirm_when_param_missing_schema'));

  const mismatch = validateToolDefinition(validTool({
    inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } } },
    confirmWhen: [{ param: 'enabled', op: '==', value: 'true' }],
  }));
  assert.ok(mismatch.some((d) => d.severity === 'error' && d.code === 'confirm_when_value_type'));

  const untypedExists = validateToolDefinition(validTool({
    inputSchema: { type: 'object', properties: { submitted: {} } },
    confirmWhen: [{ param: 'submitted', op: 'exists' }],
  }));
  assert.ok(untypedExists.some((d) => d.severity === 'error' && d.code === 'confirm_when_param_untyped'));
});
