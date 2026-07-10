// 跨语言契约测试：SDK 构建的 spec → 中枢 compileOpenApiTools 解析，断言两端对 ACC 首发契约的理解一致。
// 用法：php sdk/php/examples/build-spec.php | npx tsx scripts/sdk-contract-test.ts
//  或：npx tsx scripts/sdk-contract-test.ts <spec.json 路径>
import { readFileSync } from 'node:fs';
import { compileOpenApiTools, parseOpenApiSpec } from '../src/core/contracts/openapi-tools';

const specJson = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8');

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ← ' + extra : ''}`); }
}

const { tools, diagnostics } = compileOpenApiTools(specJson);
const by = new Map(tools.map((t) => [t.name, t]));
const parsed = parseOpenApiSpec(specJson);
if (!parsed.ok) throw new Error(parsed.error);
const rawSpec: any = parsed.spec;
const staffListAcc = rawSpec.paths?.['/opentenantapi/staff/list']?.get?.['x-agent-capability'];
const refundAcc = rawSpec.paths?.['/opentenantapi/refund/request']?.post?.['x-agent-capability'];

console.log('— SDK 产物 → 中枢派生');
ok('SDK 输出 ACC 根对象', staffListAcc?.version === 1 && staffListAcc?.enabled === true && staffListAcc?.scope === 'tenant.staff.read');
const legacyPrefix = ['x', 'ai'].join('-') + '-';
ok('SDK 不输出旧治理字段', !Object.keys(rawSpec.paths?.['/opentenantapi/staff/list']?.get ?? {}).some((k) => k.startsWith(legacyPrefix)));
ok('ACC rate_limit 使用结构化对象', JSON.stringify(staffListAcc?.execution?.rate_limit) === '{"count":60,"window":"1m"}');
ok('ACC 参数级确认落在 approval.when', JSON.stringify(refundAcc?.approval?.when) === '[{"param":"amount","op":">","value":500,"label":"超过 500 元退款需人工确认"}]');
ok('派生出 5 个工具（deprecated 不算）', tools.length === 5, `实际 ${tools.length}`);
ok('deprecated 接口被跳过且注明原因', diagnostics.some((s) => s.path.includes('list_v1') && s.code === 'deprecated'), JSON.stringify(diagnostics));

const list = by.get('staff_list');
ok('读工具基本面（scope/method）', list?.scope === 'tenant.staff.read' && list?.method === 'GET');
ok('when-to-use 拼进描述', !!list?.description.includes('何时用：用户问员工'));
ok('returns 拼进描述', !!list?.description.includes('返回：{code:1'));
ok('examples 首例拼进描述', !!list?.description.includes('示例参数：{"dept":"前厅"}'));
ok('rate-limit 解析为 60/min', list?.rateLimitPerMin === 60);
ok('enum 进参数 schema', JSON.stringify((list?.inputSchema.properties as any)?.dept?.enum) === '["前厅","后仓"]');
ok('GET 默认只读+幂等', list?.readonly === true && list?.idempotent === true);

const mq = by.get('member_query');
ok('POST 查询：readonly/idempotent 显式声明生效', mq?.readonly === true && mq?.idempotent === true);
ok('requires-subject 解析', mq?.requiresSubject === true);
ok('sensitive 解析', mq?.sensitive === true);
ok('body 参数 required 传导', JSON.stringify((mq?.inputSchema as any)?.required) === '["mobile"]');

const del = by.get('staff_delete');
ok('high+confirm 解析', del?.risk === 'high' && del?.confirmRequired === true);
ok('confirm-prompt 解析', del?.confirmPrompt === 'AI 申请删除员工 #{id}');
ok('POST 未声明 readonly → false', del?.readonly === false && del?.idempotent === false);

const refund = by.get('refund_request_create');
ok('申请类工具：medium + requires-subject', refund?.risk === 'medium' && refund?.requiresSubject === true);
ok('confirm-when 参数级确认解析', JSON.stringify(refund?.confirmWhen) === '[{"param":"amount","op":">","value":500,"label":"超过 500 元退款需人工确认"}]');
ok('业务流程返回说明拼进描述', !!refund?.description.includes('返回：{code:1, data:{request_id,status,message,url}}'));

const rep = by.get('demo_staff_monthly_report');
ok('未显式 name → 默认蛇形类前缀命名', !!rep);
ok('timeout-ms 解析（30000）', rep?.timeoutMs === 30000);

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
