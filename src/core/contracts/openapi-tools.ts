import { parseDocument } from 'yaml';
import { AGENT_CAPABILITY_KEY, deriveRisk, toolAnnotationsOf } from './tool-annotations';
import { TOOL_DEFINITION_SCHEMA_VERSION, hasToolDefinitionErrors, validateToolDefinition, type ToolCompileResult, type ToolConfirmCondition, type ToolConfirmOp, type ToolDefinition, type ToolDiagnostic, type ToolParamLocation } from './tool-definition';

const CONFIRM_OPS = new Set<ToolConfirmOp>(['>', '>=', '<', '<=', '==', '!=', 'in', 'contains', 'exists']);

export type OpenApiSpecFormat = 'json' | 'yaml';
export type OpenApiSpecParseResult =
  | { ok: true; spec: Record<string, unknown>; canonicalJson: string; format: OpenApiSpecFormat }
  | { ok: false; error: string };

/** JSON/YAML 共用的唯一解析入口；入库前统一归一化为 canonical JSON，运行时不分叉。 */
export function parseOpenApiSpec(specText: string): OpenApiSpecParseResult {
  const text = String(specText ?? '').trim();
  if (!text) return { ok: false, error: 'spec 不能为空' };
  let spec: unknown;
  let format: OpenApiSpecFormat = 'json';
  try {
    spec = JSON.parse(text);
  } catch {
    format = 'yaml';
    try {
      const document = parseDocument(text, { prettyErrors: false });
      if (document.errors.length) return { ok: false, error: `spec 不是合法 JSON 或 YAML：${document.errors[0]?.message ?? 'YAML 解析失败'}` };
      spec = document.toJS({ maxAliasCount: 100 });
    } catch (error) {
      return { ok: false, error: `spec 不是合法 JSON 或 YAML：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, error: 'OpenAPI spec 根节点必须是对象' };
  try {
    return { ok: true, spec: spec as Record<string, unknown>, canonicalJson: JSON.stringify(spec), format };
  } catch {
    return { ok: false, error: 'OpenAPI spec 包含无法转换为 JSON 的循环引用' };
  }
}

/** OpenAPI + Agent Capability Contract -> ToolDefinition。x-agent-capability 是 OpenAPI binding，不是运行时模型本身。 */
export function compileOpenApiTools(specText: string): ToolCompileResult {
  const tools: ToolDefinition[] = [];
  const diagnostics: ToolDiagnostic[] = [];
  const parsed = parseOpenApiSpec(specText);
  if (!parsed.ok) return { tools, diagnostics: [{ severity: 'error', path: '-', code: 'invalid_spec', message: parsed.error, suggestion: '请提交合法的 OpenAPI 3.x JSON 或 YAML 文档' }] };
  const spec: any = parsed.spec;
  const paths = spec?.paths ?? {};
  for (const [p, ops] of Object.entries<any>(paths)) {
    for (const [method, op] of Object.entries<any>(ops)) {
      if (!op || typeof op !== 'object') continue;
      const m = method.toUpperCase();
      const loc = `${m} ${p}`;
      const ann = toolAnnotationsOf(op);
      if (AGENT_CAPABILITY_KEY in op && !ann.present) {
        diagnostics.push({ severity: 'error', path: loc, code: 'invalid_agent_capability', message: 'x-agent-capability 必须是对象', suggestion: '为 operation 添加 x-agent-capability 对象，或移除该字段' });
        continue;
      }
      if (!ann.enabled) continue;
      if (op['deprecated'] === true) { diagnostics.push({ severity: 'error', path: loc, code: 'deprecated', message: '已标记 deprecated，不暴露（业务平滑下线中）', suggestion: '如仍需 AI 调用，请先取消 deprecated 或新增替代工具' }); continue; }
      const scope = ann.scope;
      if (!scope) { diagnostics.push({ severity: 'error', path: loc, code: 'missing_scope', message: '缺 x-agent-capability.scope', suggestion: '为 operation 添加 x-agent-capability.scope，例如 tenant.staff.read，并在路由 allow 中授权' }); continue; }

      const props: Record<string, unknown> = {};
      const required: string[] = [];
      const paramIn: Record<string, ToolParamLocation> = {};
      for (const prm of (op.parameters ?? []) as any[]) {
        if (!prm?.name || !prm?.schema) continue;
        const where = String(prm.in ?? 'query');
        const pin: ToolParamLocation = where === 'path' || where === 'header' ? where : 'query';
        props[prm.name] = { ...prm.schema, description: prm.description ?? prm.schema.description };
        paramIn[prm.name] = pin;
        if (prm.required || pin === 'path') required.push(prm.name);
        if (!prm.description && !prm.schema.description) diagnostics.push({ severity: 'warning', path: loc, code: 'param_missing_description', message: `参数 ${prm.name} 缺少 description，AI 填参稳定性会下降`, suggestion: '给参数补充 description、enum、format 或 default，帮助 AI 准确填参' });
      }
      const bodySchema = op.requestBody?.content?.['application/json']?.schema;
      if (bodySchema?.properties) {
        for (const [k, v] of Object.entries<any>(bodySchema.properties)) {
          props[k] = v;
          paramIn[k] = 'body';
          if (!v?.description) diagnostics.push({ severity: 'warning', path: loc, code: 'param_missing_description', message: `请求体参数 ${k} 缺少 description，AI 填参稳定性会下降`, suggestion: '给请求体参数补充 description、enum、format 或 default，帮助 AI 准确填参' });
        }
        for (const k of (bodySchema.required ?? []) as string[]) required.push(k);
      }
      if (m !== 'GET' && !Object.keys(props).length && bodySchema?.type !== 'object') {
        diagnostics.push({ severity: 'error', path: loc, code: 'write_without_schema', message: '写接口无参数 schema，不暴露（防 AI 瞎猜参数）', suggestion: '为非 GET operation 添加 parameters 或 application/json requestBody schema' });
        continue;
      }

      let desc = String(op.summary ?? op.description ?? scope);
      if (!op.summary && !op.description) diagnostics.push({ severity: 'warning', path: loc, code: 'missing_summary', message: '缺少 summary/description，已回落到 scope 作为工具描述', suggestion: '补充面向 Agent 的 summary，并用 x-agent-capability.guidance.when_to_use 说明适用场景' });
      if (!op.operationId) diagnostics.push({ severity: 'warning', path: loc, code: 'missing_operation_id', message: '缺少 operationId，工具名将由 method+path 生成；路径变化会导致工具名变化', suggestion: '为 operation 设置稳定 operationId，作为 AI 工具名' });
      if (ann.whenToUse) desc += `。何时用：${ann.whenToUse}`;
      if (ann.returns) desc += `。返回：${ann.returns}`;
      const ex = ann.examples.length ? ann.examples[0] : null;
      if (ex && typeof ex === 'object') desc += `。示例参数：${JSON.stringify(ex)}`;
      const confirmWhen = parseConfirmWhen(ann.confirmWhen, loc, diagnostics);
      if (confirmWhen === null) continue;

      const ro = m === 'GET' ? true : ann.readonly === true;
      const inputSchema = { type: 'object', properties: props, ...(required.length ? { required: [...new Set(required)] } : {}) };
      const tool: ToolDefinition = {
        schemaVersion: TOOL_DEFINITION_SCHEMA_VERSION,
        name: String(op.operationId ?? `${method}_${p}`.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')).slice(0, 64),
        source: 'openapi',
        method: m,
        path: p,
        description: desc.slice(0, 500),
        scope,
        risk: deriveRisk(ann.riskLevel, m, ro),
        confirmRequired: ann.confirmRequired,
        rateLimitPerMin: ann.rateLimitPerMin,
        ...(ann.rateLimit ? { rateLimit: ann.rateLimit } : {}),
        requiresSubject: ann.requiresSubject,
        sensitive: ann.sensitive,
        readonly: ro,
        idempotent: m === 'GET' ? true : ann.idempotent === true,
        timeoutMs: ann.timeoutMs,
        ...(confirmWhen.length ? { confirmWhen } : {}),
        confirmPrompt: ann.confirmPrompt,
        context: ann.context,
        ...(ann.outcome ? { outcome: ann.outcome } : {}),
        extensions: ann.extensions,
        inputSchema,
        paramIn,
      };
      const shapeDiagnostics = validateToolDefinition(tool, { path: loc });
      diagnostics.push(...shapeDiagnostics);
      if (!hasToolDefinitionErrors(shapeDiagnostics)) tools.push(tool);
    }
  }
  return { tools, diagnostics };
}

function parseConfirmWhen(raw: unknown, path: string, diagnostics: ToolDiagnostic[]): ToolConfirmCondition[] | null {
  if (raw === undefined || raw === null || raw === false) return [];
  if (!Array.isArray(raw)) {
    diagnostics.push({ severity: 'error', path, code: 'invalid_confirm_when', message: 'x-agent-capability.approval.when 必须是数组', suggestion: '示例：[{ "param": "amount", "op": ">", "value": 1000 }]' });
    return null;
  }
  const out: ToolConfirmCondition[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      diagnostics.push({ severity: 'error', path, code: 'invalid_confirm_when', message: `x-agent-capability.approval.when[${i}] 必须是对象` });
      return null;
    }
    const rec = c as Record<string, unknown>;
    const param = String(rec['param'] ?? '').trim();
    const op = String(rec['op'] ?? '').trim() as ToolConfirmOp;
    if (!param) {
      diagnostics.push({ severity: 'error', path, code: 'invalid_confirm_when_param', message: `x-agent-capability.approval.when[${i}].param 必填` });
      return null;
    }
    if (!CONFIRM_OPS.has(op)) {
      diagnostics.push({ severity: 'error', path, code: 'invalid_confirm_when_op', message: `x-agent-capability.approval.when[${i}].op 不支持：${String(rec['op'] ?? '')}` });
      return null;
    }
    if (op !== 'exists' && !('value' in rec)) {
      diagnostics.push({ severity: 'error', path, code: 'invalid_confirm_when_value', message: `x-agent-capability.approval.when[${i}].value 必填` });
      return null;
    }
    out.push({
      param,
      op,
      ...('value' in rec ? { value: rec['value'] } : {}),
      ...(typeof rec['label'] === 'string' && rec['label'].trim() ? { label: rec['label'].trim().slice(0, 120) } : {}),
    });
  }
  return out.slice(0, 20);
}
