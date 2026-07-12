// 工具治理的安全核心纯函数单测（零依赖：node:test + node:assert，tsx 直跑）。
// 覆盖：reach 白名单语义、工具调用签名（sha256= 唯一方案）、审批匹配用的参数规范化哈希。
// 这些函数是「谁够得到哪些工具 / 签名防重放篡改 / 审批认不认同一个调用」的判定底座，回归即安全事故，故钉死行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileOpenApiTools } from './openapi-tools';
import { TOOL_DEFINITION_SCHEMA_VERSION } from './tool-definition';
import { argsHash, composeToolRuntimes, LocalSlidingWindowRateLimiter, scopeAllowed, signToolCall, type ToolRuntime } from './tools';

test('scopeAllowed: 精确匹配命中', () => {
  assert.equal(scopeAllowed('goods.read', ['goods.read']), true);
  assert.equal(scopeAllowed('goods.read', ['order.read']), false);
  assert.equal(scopeAllowed('goods.read', []), false);
});

test('scopeAllowed: 前缀通配 a.* 含点边界，不跨段误命中', () => {
  assert.equal(scopeAllowed('goods.read', ['goods.*']), true);
  assert.equal(scopeAllowed('goods.write', ['goods.*']), true);
  // 'goods.*' → 前缀 'goods.'（带点）：裸 'goods' 与 'goodsly' 都不应命中
  assert.equal(scopeAllowed('goods', ['goods.*']), false);
  assert.equal(scopeAllowed('goodsly', ['goods.*']), false);
});

test('scopeAllowed: 全局 * 放行一切（仍受逐工具 risk/subject 闸约束，此处只测 reach）', () => {
  assert.equal(scopeAllowed('anything.at.all', ['*']), true);
  assert.equal(scopeAllowed('goods.read', ['order.*', '*']), true);
});

test('argsHash: 顶层键序无关（键序不同不算换动作）', () => {
  assert.equal(argsHash({ a: 1, b: 2 }), argsHash({ b: 2, a: 1 }));
});

test('argsHash: 嵌套对象键序也无关', () => {
  assert.equal(argsHash({ x: { a: 1, b: 2 }, y: 3 }), argsHash({ y: 3, x: { b: 2, a: 1 } }));
});

test('argsHash: 数组顺序敏感（顺序是语义，不可乱）', () => {
  assert.notEqual(argsHash({ ids: [1, 2] }), argsHash({ ids: [2, 1] }));
});

test('argsHash: 值变则哈希变；undefined 与空对象同哈希（?? {} 兜底）', () => {
  assert.notEqual(argsHash({ price: 10 }), argsHash({ price: 11 }));
  assert.equal(argsHash(undefined as unknown as Record<string, unknown>), argsHash({}));
});

test('argsHash: 遵循 JSON 传输语义，undefined 不生成非法规范化片段', () => {
  assert.equal(argsHash({}), argsHash({ optional: undefined }));
  assert.equal(argsHash({ values: [null] }), argsHash({ values: [undefined] }));
  assert.notEqual(argsHash({ optional: null }), argsHash({}));
});

test('LocalSlidingWindowRateLimiter: 定期清除不再活跃的桶', () => {
  let now = 0;
  const limiter = new LocalSlidingWindowRateLimiter(() => now);

  assert.equal(limiter.consume('old-tool', 1), false);
  assert.equal(limiter.consume('old-tool', 1), true);
  assert.equal(limiter.bucketCount(), 1);

  now = 60_001;
  assert.equal(limiter.consume('active-tool', 1), false);
  assert.equal(limiter.bucketCount(), 1);
});

function fakeRuntime(name: string, output: string, retrievalMode = false): ToolRuntime {
  const definition = { type: 'function' as const, function: { name, description: name, parameters: { type: 'object' } } };
  return {
    llmTools: [definition], maxCalls: 3, progressive: false, retrievalMode,
    catalog: [{ name, summary: name, scope: `${name}.read`, risk: 'low', confirm_required: false }],
    async lookup(names) { return names.includes(name) ? [definition] : []; },
    ...(retrievalMode ? { async retrieve() { return [definition]; } } : {}),
    async invoke(called) { return { ok: true, status: 200, text: `${output}:${called}` }; },
  };
}

test('composeToolRuntimes: 聚合多工具源清单并把调用路由回所属来源', async () => {
  const runtime = composeToolRuntimes([fakeRuntime('order_list', 'orders'), fakeRuntime('shipment_track', 'shipping')], 9);
  assert.equal(runtime.llmTools.length, 2);
  assert.equal(runtime.maxCalls, 9);
  assert.equal((await runtime.invoke('shipment_track', {})).text, 'shipping:shipment_track');
  assert.deepEqual((await runtime.lookup(['order_list', 'shipment_track'])).map((x) => x.function.name), ['order_list', 'shipment_track']);
});

test('composeToolRuntimes: 同名工具跨源冲突时 fail-closed', () => {
  assert.throws(() => composeToolRuntimes([fakeRuntime('duplicate', 'a'), fakeRuntime('duplicate', 'b')], 5), /工具名冲突 duplicate/);
});

const SECRET = 'test-secret-蚂蚁';
const TS = 1_700_000_000;

function acc(scope: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { 'x-agent-capability': { version: 1, enabled: true, scope, ...over } };
}

test('signToolCall: 确定性 + body 改则签名改 + 带 sha256= 前缀', () => {
  const a = signToolCall(SECRET, TS, 'POST', '/api/x?q=1', '{"n":1}', 't1:u9', 'job-1');
  assert.equal(a, signToolCall(SECRET, TS, 'POST', '/api/x?q=1', '{"n":1}', 't1:u9', 'job-1'));
  assert.notEqual(a, signToolCall(SECRET, TS, 'POST', '/api/x?q=1', '{"n":2}', 't1:u9', 'job-1'));
  assert.match(a, /^sha256=[0-9a-f]{64}$/); // 算法名前缀 + HMAC-SHA256 hex
});

test('signToolCall: 换主体或换任务都改签名（杜绝重放篡 On-Behalf-Of/Job-Id）', () => {
  const base = signToolCall(SECRET, TS, 'POST', '/api/x', '{}', 't1:u9', 'job-1');
  assert.notEqual(base, signToolCall(SECRET, TS, 'POST', '/api/x', '{}', 't1:u8', 'job-1'), '换主体应改签名');
  assert.notEqual(base, signToolCall(SECRET, TS, 'POST', '/api/x', '{}', 't1:u9', 'job-2'), '换任务应改签名');
});

test('signToolCall: spec 拉取形态（空主体空任务）确定性，且与带主体的调用不同源', () => {
  const spec = signToolCall(SECRET, TS, 'GET', '/api/x', ''); // 主体/任务缺省为空串
  assert.equal(spec, signToolCall(SECRET, TS, 'GET', '/api/x', '', '', ''));
  assert.notEqual(spec, signToolCall(SECRET, TS, 'GET', '/api/x', '', 't1:u9', 'job-1'));
});

test('compileOpenApiTools 风险安全默认下限：未标 risk 的写操作兜底 medium，GET/只读兜底 low，显式声明照走', () => {
  const P = { parameters: [{ name: 'id', in: 'query', schema: { type: 'string' } }] }; // 写接口须有参数才暴露
  const spec = JSON.stringify({
    paths: {
      '/a': { get: { ...acc('s.a'), summary: '查 a' } },                                   // GET 零参合法
      '/b': { post: { ...acc('s.b'), summary: '写 b（漏标 risk）', ...P } },
      '/c': { post: { ...acc('s.c', { execution: { readonly: true } }), summary: '查 c', ...P } },
      '/d': { post: { ...acc('s.d', { risk: { level: 'low' } }), summary: '写 d 显式 low', ...P } },
      '/e': { delete: { ...acc('s.e', { risk: { level: 'high' } }), summary: '删 e', ...P } },
    },
  });
  const tools = compileOpenApiTools(spec).tools;
  const tool = (scope: string) => { const x = tools.find((t) => t.scope === scope); assert.ok(x, `工具 ${scope} 应被暴露`); return x; };
  assert.equal(tool('s.a').risk, 'low', 'GET 兜底 low');
  assert.equal(tool('s.a').readonly, true);
  assert.equal(tool('s.b').risk, 'medium', '未标 risk 的写操作兜底 medium（留痕、不静默 low）');
  assert.equal(tool('s.b').readonly, false);
  assert.equal(tool('s.c').risk, 'low', '显式 execution.readonly 的 POST 查询兜底 low');
  assert.equal(tool('s.d').risk, 'low', '作者显式 low 照走（声明优先于下限）');
  assert.equal(tool('s.e').risk, 'high', '显式 high 照走');
});

test('compileOpenApiTools: ACC 单工具超时原值保留，超界声明不静默截断', () => {
  const makeSpec = (timeoutMs: unknown) => JSON.stringify({
    paths: {
      '/report': {
        get: {
          operationId: 'report_export',
          summary: '导出经营报表',
          ...acc('report.export', { execution: { timeout_ms: timeoutMs } }),
        },
      },
    },
  });

  const valid = compileOpenApiTools(makeSpec(120000));
  assert.equal(valid.tools[0]?.timeoutMs, 120000);
  assert.equal(valid.diagnostics.some((d) => d.severity === 'error'), false);

  const invalid = compileOpenApiTools(makeSpec(600001));
  assert.equal(invalid.tools.length, 0);
  assert.ok(invalid.diagnostics.some((d) => d.code === 'invalid_timeout'));
});

test('compileOpenApiTools: timeout_ms 保持契约严格类型，字符串数字给出可操作诊断', () => {
  const yaml = `
openapi: 3.0.0
info:
  title: Demo
  version: "1"
paths:
  /report:
    get:
      operationId: report_export
      summary: 导出经营报表
      x-agent-capability:
        version: 1
        enabled: true
        scope: report.export
        execution:
          timeout_ms: "5000"
`;

  const result = compileOpenApiTools(yaml);

  assert.equal(result.tools.length, 0);
  const diagnostic = result.diagnostics.find((d) => d.code === 'invalid_timeout_type');
  assert.equal(diagnostic?.severity, 'error');
  assert.match(diagnostic?.message ?? '', /string "5000"/);
  assert.match(diagnostic?.suggestion ?? '', /timeout_ms: 5000（不要加引号）/);
});

test('compileOpenApiTools: 业务参数走 OpenAPI schema，未知扩展保留但不参与治理', () => {
  const spec = JSON.stringify({
    paths: {
      '/order/create': {
        post: {
          operationId: 'order_create',
          summary: '创建订单',
          ...acc('order.create', {
            guidance: { context: ['tenant-boundary', 'requires-inventory-check'] },
            outcome: { result: '返回订单号和创建状态', side_effect: 'write' },
          }),
          'x-business-policy': { approval_scene: 'order_over_limit' },
          'x-business-owner': 'trade-team',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['buyer_id', 'items'],
                  properties: {
                    buyer_id: { type: 'string', description: '购买人 ID' },
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['sku_id', 'qty'],
                        properties: {
                          sku_id: { type: 'string' },
                          qty: { type: 'integer', minimum: 1 },
                          attrs: { type: 'object', additionalProperties: true },
                        },
                      },
                    },
                    remark: { type: 'string', maxLength: 200 },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const [tool] = compileOpenApiTools(spec).tools;
  assert.equal(tool?.name, 'order_create');
  assert.deepEqual(tool.context, ['tenant-boundary', 'requires-inventory-check']);
  assert.deepEqual(tool.outcome, { result: '返回订单号和创建状态', sideEffect: 'write' });
  assert.deepEqual(tool.extensions, {
    'x-business-policy': { approval_scene: 'order_over_limit' },
    'x-business-owner': 'trade-team',
  });
  assert.deepEqual((tool.inputSchema.properties as Record<string, unknown>)['items'], {
    type: 'array',
    items: {
      type: 'object',
      required: ['sku_id', 'qty'],
      properties: {
        sku_id: { type: 'string' },
        qty: { type: 'integer', minimum: 1 },
        attrs: { type: 'object', additionalProperties: true },
      },
    },
  });
});

test('compileOpenApiTools: approval.when 进入 ToolDefinition 而不是扩展袋', () => {
  const spec = JSON.stringify({
    paths: {
      '/refund': {
        post: {
          operationId: 'refund_create',
          summary: '创建退款单',
          ...acc('refund.write', {
            risk: { level: 'medium' },
            approval: { when: [{ param: 'amount', op: '>', value: 1000, label: '退款金额超过 1000' }] },
          }),
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              order_id: { type: 'string', description: '订单号' },
              amount: { type: 'number', description: '金额' },
            },
            required: ['order_id', 'amount'],
          } } } },
        },
      },
    },
  });

  const { tools, diagnostics } = compileOpenApiTools(spec);

  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0]?.confirmWhen, [{ param: 'amount', op: '>', value: 1000, label: '退款金额超过 1000' }]);
  assert.equal(tools[0]?.extensions['x-agent-capability'], undefined);
  assert.equal(diagnostics.some((d) => d.severity === 'error'), false);
});

test('compileOpenApiTools: approval.when 格式错误时阻断工具，避免误以为条件审批生效', () => {
  const spec = JSON.stringify({
    paths: {
      '/refund': {
        post: {
          operationId: 'refund_create',
          summary: '创建退款单',
          ...acc('refund.write', {
            approval: { when: [{ param: 'amount', op: 'roughly', value: 1000 }] },
          }),
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            properties: { amount: { type: 'number', description: '金额' } },
            required: ['amount'],
          } } } },
        },
      },
    },
  });

  const { tools, diagnostics } = compileOpenApiTools(spec);

  assert.equal(tools.length, 0);
  assert.ok(diagnostics.some((d) => d.severity === 'error' && d.code === 'invalid_confirm_when_op'));
});

test('compileOpenApiTools: 输出 ToolDefinition schema/source、diagnostics，并保留 path/header 参数位置', () => {
  const spec = JSON.stringify({
    paths: {
      '/stores/{store_id}/staff': {
        get: {
          ...acc('tenant.staff.read'),
          parameters: [
            { name: 'store_id', in: 'path', required: true, schema: { type: 'string' }, description: '门店 ID' },
            { name: 'x-tenant-id', in: 'header', schema: { type: 'string' } },
            { name: 'keyword', in: 'query', schema: { type: 'string' } },
          ],
        },
      },
    },
  });

  const { tools, diagnostics } = compileOpenApiTools(spec);
  const [tool] = tools;
  assert.equal(tool?.schemaVersion, TOOL_DEFINITION_SCHEMA_VERSION);
  assert.equal(tool?.source, 'openapi');
  assert.equal(tool?.paramIn['store_id'], 'path');
  assert.equal(tool?.paramIn['x-tenant-id'], 'header');
  assert.equal(tool?.paramIn['keyword'], 'query');
  assert.deepEqual(tool?.inputSchema['required'], ['store_id']);
  assert.ok(diagnostics.some((d) => d.severity === 'warning' && d.code === 'missing_operation_id'));
  assert.ok(diagnostics.some((d) => d.severity === 'warning' && d.code === 'param_missing_description' && d.message.includes('x-tenant-id')));
});

test('compileOpenApiTools: Cookie、未知和缺失参数位置均 fail-closed，不静默映射为 query', () => {
  const operation = (scope: string, parameter: Record<string, unknown>) => ({
    operationId: scope.replace('.', '_'),
    summary: '读取示例',
    ...acc(scope),
    parameters: [{ name: 'session_id', description: '会话标识', schema: { type: 'string' }, ...parameter }],
  });
  const spec = JSON.stringify({
    paths: {
      '/cookie': { get: operation('demo.cookie', { in: 'cookie', required: true }) },
      '/unknown': { get: operation('demo.unknown', { in: 'formData' }) },
      '/missing': { get: operation('demo.missing', {}) },
    },
  });

  const result = compileOpenApiTools(spec);

  assert.equal(result.tools.length, 0);
  const diagnostics = result.diagnostics.filter((d) => d.code === 'unsupported_param_location');
  assert.deepEqual(diagnostics.map((d) => d.path), ['GET /cookie', 'GET /unknown', 'GET /missing']);
  assert.ok(diagnostics.every((d) => d.severity === 'error'));
  assert.match(diagnostics[0]?.message ?? '', /"cookie"/);
  assert.match(diagnostics[1]?.message ?? '', /"formData"/);
  assert.match(diagnostics[2]?.message ?? '', /未声明/);
  assert.match(diagnostics[0]?.suggestion ?? '', /签名头和业务侧授权/);
});

test('compileOpenApiTools: 编译阻断统一输出 error diagnostics', () => {
  const invalid = compileOpenApiTools('{bad-json');
  assert.equal(invalid.tools.length, 0);
  assert.equal(invalid.diagnostics[0]?.severity, 'error');
  assert.equal(invalid.diagnostics[0]?.code, 'invalid_spec');
  assert.match(invalid.diagnostics[0]?.message ?? '', /不是合法 JSON 或 YAML/);

  const spec = JSON.stringify({
    paths: {
      '/legacy': {
        post: {
          deprecated: true,
          ...acc('legacy.write'),
          parameters: [{ name: 'id', in: 'query', schema: { type: 'string' } }],
        },
      },
      '/no-scope': {
        get: {
          ...acc(''),
          summary: '缺 scope',
        },
      },
      '/blind-write': {
        post: {
          ...acc('blind.write'),
          summary: '无 schema 写接口',
        },
      },
    },
  });

  const result = compileOpenApiTools(spec);
  assert.equal(result.tools.length, 0);
  assert.ok(result.diagnostics.some((d) => d.severity === 'error' && d.code === 'deprecated' && d.path === 'POST /legacy'));
  assert.ok(result.diagnostics.some((d) => d.severity === 'error' && d.code === 'missing_scope' && d.path === 'GET /no-scope'));
  assert.ok(result.diagnostics.some((d) => d.severity === 'error' && d.code === 'write_without_schema' && d.path === 'POST /blind-write'));
});

test('compileOpenApiTools: YAML 与 JSON 进入同一编译链', () => {
  const yaml = `
openapi: 3.0.0
info:
  title: Demo
  version: "1"
paths:
  /orders:
    get:
      operationId: order_list
      summary: 查询订单
      x-agent-capability:
        version: 1
        enabled: true
        scope: order.read
`;
  const result = compileOpenApiTools(yaml);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0]?.name, 'order_list');
  assert.equal(result.tools[0]?.scope, 'order.read');
});

test('compileOpenApiTools: 候选工具必须通过 ToolDefinition 契约校验才进入清单', () => {
  const spec = JSON.stringify({
    paths: {
      '/stores/{store_id}/staff': {
        get: {
          operationId: 'tenant.staff.list',
          summary: '查询员工',
          ...acc('tenant.staff.read'),
          parameters: [
            { name: 'keyword', in: 'query', schema: { type: 'string' }, description: '搜索词' },
          ],
        },
      },
    },
  });

  const result = compileOpenApiTools(spec);

  assert.equal(result.tools.length, 0);
  assert.ok(result.diagnostics.some((d) => d.severity === 'error' && d.code === 'invalid_name' && d.path === 'GET /stores/{store_id}/staff'));
  assert.ok(result.diagnostics.some((d) => d.severity === 'error' && d.code === 'path_param_missing' && d.message.includes('store_id')));
});
