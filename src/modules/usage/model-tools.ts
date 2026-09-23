import type { UsageService, UsageServiceConfig } from './contracts';
import { usageAssert } from './errors';
import { assertKnownFields } from './validation';

export interface ModelToolParameter {
  name: string; type: 'string' | 'number' | 'boolean' | 'file'; required: boolean; description: string;
}
export interface ModelToolConfig {
  name: string; capability: string; description: string; outputs: string[]; parameters: ModelToolParameter[];
  adapter: 'pending' | 'aliyun-image' | 'aliyun-image-native' | 'openrouter-image';
}
const identifier = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const safeName = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v);
export function validateModelToolConfig(config: Pick<UsageServiceConfig, 'purpose' | 'tool'>): void {
  usageAssert(config.purpose === undefined || config.purpose === 'chat' || config.purpose === 'tool', 'USAGE_INVALID_INPUT', '服务用途必须为对话模型或模型工具。', 400);
  if (config.purpose !== 'tool') {
    usageAssert(config.tool === undefined, 'USAGE_INVALID_INPUT', '对话模型不能附带工具配置。', 400); return;
  }
  const tool = config.tool;
  assertKnownFields(tool, ['name','capability','description','outputs','parameters','adapter'], 'model tool');
  usageAssert(tool && typeof tool.name === 'string' && identifier.test(tool.name) && safeName(tool.capability, 80)
    && typeof tool.description === 'string' && tool.description.trim().length > 0 && tool.description.length <= 1200,
  'USAGE_INVALID_INPUT', '请填写有效的工具名称、能力类型及使用说明。', 400);
  usageAssert(['pending','aliyun-image','aliyun-image-native','openrouter-image'].includes(tool.adapter), 'USAGE_TOOL_ADAPTER_UNSUPPORTED', '生成适配不受支持。', 400);
  usageAssert(Array.isArray(tool.outputs) && tool.outputs.length > 0 && tool.outputs.length <= 8
    && tool.outputs.every(v => safeName(v, 64)) && new Set(tool.outputs).size === tool.outputs.length,
  'USAGE_INVALID_INPUT', '工具输出类型无效。', 400);
  usageAssert(Array.isArray(tool.parameters) && tool.parameters.length <= 32, 'USAGE_INVALID_INPUT', '工具参数声明无效。', 400);
  const names = new Set<string>();
  for (const p of tool.parameters) {
    assertKnownFields(p, ['name','type','required','description'], 'tool parameter');
    usageAssert(p && typeof p.name === 'string' && identifier.test(p.name) && !['__proto__','constructor','prototype'].includes(p.name)
      && !names.has(p.name) && ['string','number','boolean','file'].includes(p.type) && typeof p.required === 'boolean'
      && safeName(p.description, 500), 'USAGE_INVALID_INPUT', '工具参数名称、类型或说明无效。', 400);
    names.add(p.name);
  }
  if (tool.adapter !== 'pending') {
    usageAssert(tool.capability === 'image_generation' && tool.outputs.includes('image'), 'USAGE_INVALID_INPUT', '当前执行适配仅支持图片生成。', 400);
    usageAssert(tool.parameters.some(p => p.name === 'prompt' && p.type === 'string' && p.required), 'USAGE_INVALID_INPUT', '图片工具必须声明必填的 prompt 文本。',400);
    const supported = tool.adapter.startsWith('aliyun-image') ? ['prompt','n','size','seed','negative_prompt','watermark','prompt_extend','enable_thinking'] : ['prompt','n','size','resolution','aspect_ratio','seed'];
    usageAssert(tool.parameters.every(p=>supported.includes(p.name) && p.type !== 'file'), 'USAGE_INVALID_INPUT','当前适配为文生图；参数须使用已支持的生成参数。',400);
  }
}
export function isModelTool(service: UsageService): boolean { return service.config.purpose === 'tool'; }
/** Only authorized services reach this projection. Never includes credential references or provider configuration. */
export function modelToolDescriptor(service: UsageService, multiplier = 1) {
  validateModelToolConfig(service.config);
  usageAssert(isModelTool(service) && service.config.tool, 'USAGE_INVALID_INPUT', '服务不是模型工具。', 400);
  const tool = service.config.tool;
  return {
    schema: 'bailing.model-tool.v1', service_id: service.id, service_revision: service.revision,
    label: service.label, capability: tool.capability, outputs: tool.outputs,
    state: tool.adapter === 'pending' ? 'unavailable' : 'ready', reason: tool.adapter === 'pending' ? 'MODEL_TOOL_ADAPTER_NOT_READY' : null, callable: tool.adapter !== 'pending',
    orchestration: 'host', billing_unit: 'USD', billing_scope: 'shared_plan',
    billing_rate: { multiplier },
    tool: { name: tool.name, description: tool.description, input_schema: { type: 'object', additionalProperties: false,
      properties: Object.fromEntries(tool.parameters.map(p => [p.name, {
        type: p.type === 'file' ? 'string' : p.type, description: p.description,
        ...(p.type === 'file' ? { 'x-bailing-value': 'artifact_ref' } : {}),
      }])), required: tool.parameters.filter(p => p.required).map(p => p.name) } },
  };
}
