export type ToolSourceKind = 'openapi' | 'overlay' | 'sdk' | 'mcp' | 'manual';
export type ToolRisk = 'low' | 'medium' | 'high';
export type ToolParamLocation = 'query' | 'body' | 'path' | 'header';
export type ToolDiagnosticSeverity = 'error' | 'warning' | 'info';
export type ToolConfirmOp = '>' | '>=' | '<' | '<=' | '==' | '!=' | 'in' | 'contains' | 'exists';
export type ToolRateLimitWindow = '1s' | '1m' | '1h' | '1d';
export type ToolOutcomeSideEffect = 'none' | 'read' | 'write' | 'notify' | 'external';

export const TOOL_DEFINITION_SCHEMA_VERSION = 'bailing.tool-definition.v1';
export const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const SOURCE_KINDS: readonly ToolSourceKind[] = ['openapi', 'overlay', 'sdk', 'mcp', 'manual'];
const RISKS: readonly ToolRisk[] = ['low', 'medium', 'high'];
const PARAM_LOCS: readonly ToolParamLocation[] = ['query', 'body', 'path', 'header'];
const CONFIRM_OPS: readonly ToolConfirmOp[] = ['>', '>=', '<', '<=', '==', '!=', 'in', 'contains', 'exists'];
const RATE_LIMIT_WINDOWS: readonly ToolRateLimitWindow[] = ['1s', '1m', '1h', '1d'];
const OUTCOME_SIDE_EFFECTS: readonly ToolOutcomeSideEffect[] = ['none', 'read', 'write', 'notify', 'external'];
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export interface ToolConfirmCondition {
  param: string;
  op: ToolConfirmOp;
  value?: unknown;
  label?: string;
}

export interface ToolRateLimit {
  count: number;
  window: ToolRateLimitWindow;
}

export interface ToolOutcome {
  result: string;
  sideEffect: ToolOutcomeSideEffect;
}

export interface ToolDefinition {
  schemaVersion: typeof TOOL_DEFINITION_SCHEMA_VERSION;
  name: string;
  source: ToolSourceKind;
  method: string;
  path: string;
  description: string;
  scope: string;
  risk: ToolRisk;
  confirmRequired: boolean;
  rateLimitPerMin: number;
  rateLimit?: ToolRateLimit;
  requiresSubject: boolean;
  sensitive: boolean;
  readonly: boolean;
  idempotent: boolean;
  timeoutMs: number;
  confirmWhen?: ToolConfirmCondition[];
  confirmPrompt: string;
  context: string[];
  outcome?: ToolOutcome;
  extensions: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  paramIn: Record<string, ToolParamLocation>;
}

export interface ToolDiagnostic {
  severity: ToolDiagnosticSeverity;
  path: string;
  code: string;
  message: string;
  suggestion?: string;
}

export interface ToolCompileResult {
  tools: ToolDefinition[];
  diagnostics: ToolDiagnostic[];
}

/** 从工具入参 JSON Schema 中定位点路径；参数级审批只能引用已声明的业务参数。 */
export function schemaAtPath(inputSchema: unknown, path: string): Record<string, unknown> | null {
  let current: unknown = inputSchema;
  for (const part of path.split('.').filter(Boolean)) {
    if (!isRecord(current) || !isRecord(current['properties']) || !isRecord(current['properties'][part])) return null;
    current = current['properties'][part];
  }
  return isRecord(current) ? current : null;
}

/** 提取 schema 声明的 JSON 基础类型；审批条件只接受显式类型。 */
export function schemaTypes(schema: Record<string, unknown>): string[] {
  const raw = schema['type'];
  return Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string')
    : typeof raw === 'string' ? [raw] : [];
}

/** 只判断 JSON 基础类型，不替业务侧代管 enum、format 等业务校验。 */
export function valueMatchesSchemaType(value: unknown, schema: Record<string, unknown>): boolean {
  const types = schemaTypes(schema);
  if (!types.length) return true;
  if (value === null) return types.includes('null') || schema['nullable'] === true;
  return types.some((type) => {
    switch (type) {
      case 'string': return typeof value === 'string';
      case 'boolean': return typeof value === 'boolean';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'integer': return typeof value === 'number' && Number.isInteger(value);
      case 'array': return Array.isArray(value);
      case 'object': return isRecord(value);
      default: return false;
    }
  });
}

export function toolSummary(t: Pick<ToolDefinition, 'description'>): string {
  return t.description.split('。')[0]!.slice(0, 80);
}

export function skippedDiagnostics(diags: ToolDiagnostic[]): Array<{ path: string; reason: string; code: string }> {
  return diags
    .filter((d) => d.severity === 'error')
    .map((d) => ({ path: d.path, reason: d.message, code: d.code }));
}

export function warningDiagnostics(diags: ToolDiagnostic[]): Array<{ path: string; message: string; code: string; suggestion?: string }> {
  return diags
    .filter((d) => d.severity === 'warning')
    .map((d) => ({ path: d.path, message: d.message, code: d.code, ...(d.suggestion ? { suggestion: d.suggestion } : {}) }));
}

export function validateToolDefinition(tool: unknown, opts: { path?: string } = {}): ToolDiagnostic[] {
  const path = opts.path ?? toolDiagnosticPath(tool);
  const diagnostics: ToolDiagnostic[] = [];
  const fail = (code: string, message: string, suggestion?: string) => {
    diagnostics.push({ severity: 'error', path, code, message, ...(suggestion ? { suggestion } : {}) });
  };
  const warn = (code: string, message: string, suggestion?: string) => {
    diagnostics.push({ severity: 'warning', path, code, message, ...(suggestion ? { suggestion } : {}) });
  };

  if (!isRecord(tool)) {
    fail('invalid_tool_definition', 'ToolDefinition 必须是对象', '请检查输入编译器输出，确保每个工具都是完整对象');
    return diagnostics;
  }

  if (tool['schemaVersion'] !== TOOL_DEFINITION_SCHEMA_VERSION) fail('invalid_schema_version', `schemaVersion 必须是 ${TOOL_DEFINITION_SCHEMA_VERSION}`, '请升级输入编译器或显式转换到当前 ToolDefinition 版本');
  if (typeof tool['name'] !== 'string' || !TOOL_NAME_RE.test(tool['name'])) fail('invalid_name', '工具名必须是 1~64 位机器可读标识，且以字母或下划线开头', '优先使用稳定 operationId，避免路径变化导致工具名变化');
  if (!SOURCE_KINDS.includes(tool['source'] as ToolSourceKind)) fail('invalid_source', 'source 必须是 openapi / overlay / sdk / mcp / manual 之一');
  if (typeof tool['method'] !== 'string' || !METHODS.has(tool['method'])) fail('invalid_method', 'method 必须是大写 HTTP 方法');
  if (typeof tool['path'] !== 'string' || !tool['path'].startsWith('/')) fail('invalid_path', 'path 必须以 / 开头');
  if (typeof tool['description'] !== 'string' || !tool['description'].trim()) fail('invalid_description', 'description 必须是非空字符串', '补充面向 AI 的一句话用途说明');
  if (typeof tool['scope'] !== 'string' || !tool['scope'].trim()) fail('invalid_scope', 'scope 必须是非空字符串', '为工具声明稳定权限标签，例如 tenant.staff.read');
  if (!RISKS.includes(tool['risk'] as ToolRisk)) fail('invalid_risk', 'risk 必须是 low / medium / high 之一');

  for (const key of ['confirmRequired', 'requiresSubject', 'sensitive', 'readonly', 'idempotent']) {
    if (typeof tool[key] !== 'boolean') fail('invalid_boolean', `${key} 必须是 boolean`);
  }
  if (!Number.isInteger(tool['rateLimitPerMin']) || Number(tool['rateLimitPerMin']) < 0) fail('invalid_rate_limit', 'rateLimitPerMin 必须是非负整数');
  if (tool['rateLimit'] !== undefined) {
    if (!isRecord(tool['rateLimit'])) {
      fail('invalid_rate_limit', 'rateLimit 必须是对象');
    } else {
      if (!Number.isInteger(tool['rateLimit']['count']) || Number(tool['rateLimit']['count']) <= 0) fail('invalid_rate_limit_count', 'rateLimit.count 必须是正整数');
      if (!RATE_LIMIT_WINDOWS.includes(tool['rateLimit']['window'] as ToolRateLimitWindow)) fail('invalid_rate_limit_window', 'rateLimit.window 必须是 1s / 1m / 1h / 1d');
    }
  }
  const timeoutMs = Number(tool['timeoutMs']);
  if (!Number.isInteger(tool['timeoutMs']) || timeoutMs < 0 || timeoutMs > 600000) {
    fail('invalid_timeout', 'timeoutMs 必须是 0（继承工具源默认值）或 1~600000 的整数');
  }
  if (typeof tool['confirmPrompt'] !== 'string') fail('invalid_confirm_prompt', 'confirmPrompt 必须是字符串');
  if (tool['confirmWhen'] !== undefined) {
    if (!Array.isArray(tool['confirmWhen'])) {
      fail('invalid_confirm_when', 'confirmWhen 必须是数组');
    } else {
      tool['confirmWhen'].forEach((cond, i) => {
        if (!isRecord(cond)) { fail('invalid_confirm_when', `confirmWhen[${i}] 必须是对象`); return; }
        if (typeof cond['param'] !== 'string' || !cond['param'].trim()) fail('invalid_confirm_when_param', `confirmWhen[${i}].param 必须是非空字符串`);
        if (!CONFIRM_OPS.includes(cond['op'] as ToolConfirmOp)) fail('invalid_confirm_when_op', `confirmWhen[${i}].op 不支持`);
        if (cond['label'] !== undefined && typeof cond['label'] !== 'string') fail('invalid_confirm_when_label', `confirmWhen[${i}].label 必须是字符串`);
        const op = cond['op'] as ToolConfirmOp;
        if (op !== 'exists' && !('value' in cond)) {
          fail('invalid_confirm_when_value', `confirmWhen[${i}].value 必填`);
        }
      });
    }
  }

  if (!Array.isArray(tool['context']) || tool['context'].some((x) => typeof x !== 'string' || !x.trim())) {
    fail('invalid_context', 'context 必须是非空字符串数组');
  }
  if (tool['outcome'] !== undefined) {
    if (!isRecord(tool['outcome'])) {
      fail('invalid_outcome', 'outcome 必须是对象');
    } else {
      if (typeof tool['outcome']['result'] !== 'string' || !tool['outcome']['result'].trim()) fail('invalid_outcome_result', 'outcome.result 必须是非空字符串');
      if (!OUTCOME_SIDE_EFFECTS.includes(tool['outcome']['sideEffect'] as ToolOutcomeSideEffect)) fail('invalid_outcome_side_effect', 'outcome.sideEffect 必须是 none / read / write / notify / external');
    }
  }
  if (!isRecord(tool['extensions'])) {
    fail('invalid_extensions', 'extensions 必须是对象');
  } else {
    for (const k of Object.keys(tool['extensions'])) {
      if (!/^x-(bailing|business)-/.test(k)) warn('extension_namespace', `扩展字段 ${k} 不在 x-bailing-* / x-business-* 命名空间内`, '业务私有扩展建议使用 x-business-*，框架扩展使用 x-bailing-*');
    }
  }

  if (!isRecord(tool['inputSchema'])) {
    fail('invalid_input_schema', 'inputSchema 必须是 JSON Schema 对象');
  } else {
    if (tool['inputSchema']['type'] !== 'object') fail('invalid_input_schema', 'inputSchema.type 必须是 object');
    if (!isRecord(tool['inputSchema']['properties'])) fail('invalid_input_schema_properties', 'inputSchema.properties 必须是对象');
    const props = isRecord(tool['inputSchema']['properties']) ? tool['inputSchema']['properties'] : {};
    const required = tool['inputSchema']['required'];
    if (required !== undefined && (!Array.isArray(required) || required.some((x) => typeof x !== 'string'))) {
      fail('invalid_input_schema_required', 'inputSchema.required 必须是字符串数组');
    } else if (Array.isArray(required)) {
      const seen = new Set<string>();
      for (const k of required) {
        if (seen.has(k)) fail('duplicate_required_param', `required 参数 ${k} 重复声明`);
        seen.add(k);
        if (!(k in props)) fail('required_param_missing_schema', `required 参数 ${k} 未在 properties 中定义 schema`, 'required 中的每个参数都必须有 schema，避免 AI 看到不可填的必填项');
      }
    }
  }

  if (Array.isArray(tool['confirmWhen']) && isRecord(tool['inputSchema'])) {
    tool['confirmWhen'].forEach((cond, i) => {
      if (!isRecord(cond) || typeof cond['param'] !== 'string' || !cond['param'].trim()) return;
      const schema = schemaAtPath(tool['inputSchema'], cond['param']);
      if (!schema) {
        fail('confirm_when_param_missing_schema', `confirmWhen[${i}].param ${cond['param']} 未在 inputSchema.properties 中声明`, '参数级确认只能引用工具已声明的业务参数；请补充参数 schema 或修正 param 点路径');
        return;
      }
      const op = cond['op'] as ToolConfirmOp;
      const types = schemaTypes(schema);
      if (!types.length) {
        fail('confirm_when_param_untyped', `confirmWhen[${i}].param ${cond['param']} 缺少可比较的 JSON Schema type`, '为条件参数声明明确 type，避免字符串/数字/布尔值被隐式混用');
        return;
      }
      if (op === 'exists') return;
      if (['>', '>=', '<', '<='].includes(op)) {
        if (!(types.includes('number') || types.includes('integer')) || !valueMatchesSchemaType(cond['value'], { type: types.includes('integer') ? 'integer' : 'number' })) {
          fail('confirm_when_numeric_type', `confirmWhen[${i}] 的 ${op} 仅支持 number / integer 参数和值`, '金额、数量等阈值参数应声明为 number 或 integer，并使用 JSON 数字 value');
        }
        return;
      }
      if (op === 'in') {
        if (!Array.isArray(cond['value']) || cond['value'].some((value) => !valueMatchesSchemaType(value, schema))) {
          fail('confirm_when_in_type', `confirmWhen[${i}].value 必须是与参数 ${cond['param']} 类型一致的数组`, '示例：string 参数用 ["pending","blocked"]；number 参数用 [1,2]');
        }
        return;
      }
      if (op === 'contains') {
        const value = cond['value'];
        if (types.includes('string') && typeof value !== 'string') {
          fail('confirm_when_contains_type', `confirmWhen[${i}] 的字符串 contains 条件 value 必须是 string`, '字符串参数示例：{ "param":"reason", "op":"contains", "value":"敏感" }');
        } else if (!types.includes('string') && !types.includes('array')) {
          fail('confirm_when_contains_type', `confirmWhen[${i}] 的 contains 仅支持 string 或 array 参数`, '请改用 == / in，或把参数声明为 string / array');
        }
        return;
      }
      if (!valueMatchesSchemaType(cond['value'], schema)) {
        fail('confirm_when_value_type', `confirmWhen[${i}].value 与参数 ${cond['param']} 的 JSON Schema type 不一致`, '条件 value 必须与业务参数使用同一种 JSON 类型，不进行字符串强转');
      }
    });
  }

  if (!isRecord(tool['paramIn'])) {
    fail('invalid_param_in', 'paramIn 必须是对象');
  } else {
    const props = isRecord(tool['inputSchema']) && isRecord(tool['inputSchema']['properties']) ? tool['inputSchema']['properties'] : {};
    for (const [k, v] of Object.entries(tool['paramIn'])) {
      if (!PARAM_LOCS.includes(v as ToolParamLocation)) fail('invalid_param_location', `参数 ${k} 的位置必须是 query / body / path / header 之一`);
      if (!(k in props)) fail('param_location_without_schema', `paramIn.${k} 没有对应 inputSchema.properties.${k}`, '每个可传参数都必须同时有位置和 schema');
    }
    const placeholders = pathPlaceholders(typeof tool['path'] === 'string' ? tool['path'] : '');
    for (const k of placeholders) {
      if (tool['paramIn'][k] !== 'path') fail('path_param_missing', `路径参数 ${k} 必须在 paramIn 中声明为 path`, 'OpenAPI path 参数必须有 parameters schema，Overlay/MCP 输入也要显式补齐');
    }
    for (const [k, v] of Object.entries(tool['paramIn'])) {
      if (v === 'path' && !placeholders.includes(k)) warn('path_param_not_in_path', `参数 ${k} 声明为 path，但 path 中没有 {${k}} 占位`, '确认它是否应改为 query/header/body');
    }
  }

  return diagnostics;
}

export function hasToolDefinitionErrors(diags: ToolDiagnostic[]): boolean {
  return diags.some((d) => d.severity === 'error');
}

function toolDiagnosticPath(tool: unknown): string {
  if (!isRecord(tool)) return '-';
  const method = typeof tool['method'] === 'string' ? tool['method'] : '';
  const path = typeof tool['path'] === 'string' ? tool['path'] : '';
  if (method && path) return `${method} ${path}`;
  return typeof tool['name'] === 'string' ? tool['name'] : '-';
}

function pathPlaceholders(path: string): string[] {
  return [...path.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!).filter(Boolean);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
