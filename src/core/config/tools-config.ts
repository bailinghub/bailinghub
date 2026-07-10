export interface ToolSourceConfig {
  provider: string;
  allow: string[];
  subject_field?: string;
  retrieval?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SendMessageConfig {
  channels: string[];
  [key: string]: unknown;
}

export interface ToolApprovalConfig {
  type: string;
  url?: string;
  to?: string;
  [key: string]: unknown;
}

export interface RouteToolsConfig {
  sources?: ToolSourceConfig[];
  max_calls?: number;
  builtin?: {
    send_message?: SendMessageConfig;
    [key: string]: unknown;
  };
  approval?: ToolApprovalConfig;
  [key: string]: unknown;
}

export type ToolProviderExists = (name: string) => Promise<boolean>;

const DISALLOWED_FLAT_TOOLS_FIELDS = ['provider', 'allow', 'subject_field', 'send_channels', 'approver', 'source'];

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

export function routeToolsConfig(v: unknown): RouteToolsConfig | null {
  return record(v) as RouteToolsConfig | null;
}

export function toolSourceConfigs(v: unknown): ToolSourceConfig[] {
  const cfg = routeToolsConfig(v);
  if (!Array.isArray(cfg?.sources)) return [];
  return cfg.sources.flatMap((value) => {
    const src = record(value);
    const provider = String(src?.provider ?? '').trim();
    const allow = Array.isArray(src?.allow) ? [...new Set(src.allow.map((x) => String(x).trim()).filter(Boolean))] : [];
    return provider && allow.length ? [{ ...src, provider, allow } as ToolSourceConfig] : [];
  });
}

export function maxToolCalls(v: unknown): number {
  const cfg = routeToolsConfig(v);
  return Math.min(Math.max(Number(cfg?.max_calls ?? 5) || 5, 1), 50);
}

export function sendMessageConfig(v: unknown): SendMessageConfig | null {
  const cfg = routeToolsConfig(v);
  const send = record(record(cfg?.builtin)?.send_message);
  const channels = Array.isArray(send?.channels) ? send.channels.map((x) => String(x).trim()).filter(Boolean) : [];
  return channels.length ? { ...send, channels } as SendMessageConfig : null;
}

export function approvalConfig(v: unknown): ToolApprovalConfig | null {
  const cfg = routeToolsConfig(v);
  const ap = record(cfg?.approval);
  const type = String(ap?.type ?? '').trim();
  return type ? { ...ap, type } as ToolApprovalConfig : null;
}

export async function validateRouteToolsConfig(v: unknown, toolProviderExists?: ToolProviderExists): Promise<string | null> {
  const toolsCfg = routeToolsConfig(v);
  if (!toolsCfg || !Object.keys(toolsCfg).length) return null;

  const unknownFlat = DISALLOWED_FLAT_TOOLS_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(toolsCfg, k));
  if (unknownFlat.length) {
    return `tools 必须使用结构化配置：tools.sources / tools.builtin / tools.approval；不支持顶层扁平字段：${unknownFlat.join(',')}`;
  }

  if (toolsCfg.max_calls !== undefined) {
    const maxCalls = Number(toolsCfg.max_calls);
    if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 50) return 'tools.max_calls 必须是 1..50 的整数';
  }
  if (toolsCfg.sources !== undefined) {
    if (!Array.isArray(toolsCfg.sources) || !toolsCfg.sources.length) return 'tools.sources 必须是非空数组';
    const names = new Set<string>();
    for (let i = 0; i < toolsCfg.sources.length; i++) {
      const sourceCfg = record(toolsCfg.sources[i]);
      if (!sourceCfg) return `tools.sources[${i}] 必须是对象`;
      const provider = String(sourceCfg.provider ?? '').trim();
      const allow = Array.isArray(sourceCfg.allow) ? sourceCfg.allow.map((x) => String(x).trim()).filter(Boolean) : [];
      if (!provider) return `tools.sources[${i}].provider 必填`;
      if (names.has(provider)) return `tools.sources 不允许重复引用工具源 ${provider}`;
      names.add(provider);
      if (toolProviderExists && !(await toolProviderExists(provider))) return `工具源 ${provider} 未注册（先在「工具源」登记）`;
      if (!allow.length) return `tools.sources[${i}].allow 必须是非空 scope 白名单数组`;
    }
  }

  if (toolsCfg.builtin !== undefined) {
    const builtin = record(toolsCfg.builtin);
    if (!builtin) return 'tools.builtin 必须是对象';
    const sendMessage = builtin.send_message;
    if (sendMessage !== undefined) {
      const send = record(sendMessage);
      if (!send) return 'tools.builtin.send_message 必须是对象';
      const channels = Array.isArray(send.channels) ? send.channels.map((x) => String(x).trim()).filter(Boolean) : [];
      if (!channels.length) return 'tools.builtin.send_message.channels 必须是非空数组';
    }
  }

  if (toolsCfg.approval !== undefined) {
    const approval = record(toolsCfg.approval);
    if (!approval) return 'tools.approval 必须是对象';
    const type = String(approval.type ?? '').trim();
    if (!type) return 'tools.approval.type 必填';
    if ((type === 'business_webhook' || type === 'approval_webhook' || type === 'webhook') && !String(approval.url ?? '').trim()) {
      return `tools.approval.type=${type} 时 url 必填`;
    }
  }

  return null;
}
