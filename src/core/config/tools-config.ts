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

/**
 * 本地 Agent 直调工具面是独立的明示授权，不从 route.permission 或 scope allow
 * 推导。只读工具在 enabled=true 时可见；写工具必须按 operationId 精确列出。
 * 已暴露写工具默认继承 ACC 风险/审批声明；只有再次精确列入
 * force_approval_tools 才由路由额外强制审批。不接受通配符。
 *
 * unattended_write_tools 仅用于兼容私有候选的旧配置：存在该字段且没有新字段时，
 * 仍按“其余 write_tools 强制审批”的旧语义解析；保存配置时应迁移为
 * force_approval_tools，未配置任何审批覆盖即表示继承 ACC。
 */
export interface AgentDirectToolsConfig {
  enabled: boolean;
  write_tools?: string[];
  force_approval_tools?: string[];
  /** @deprecated 使用 force_approval_tools 明示额外强制审批。 */
  unattended_write_tools?: string[];
}

export interface ResolvedAgentDirectToolsConfig {
  enabled: true;
  write_tools: string[];
  force_approval_tools: string[];
}

export interface RouteToolsConfig {
  sources?: ToolSourceConfig[];
  max_calls?: number;
  builtin?: {
    send_message?: SendMessageConfig;
    [key: string]: unknown;
  };
  approval?: ToolApprovalConfig;
  agent_direct?: AgentDirectToolsConfig;
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

export function agentDirectToolsConfig(v: unknown): ResolvedAgentDirectToolsConfig | null {
  const cfg = routeToolsConfig(v);
  const direct = record(cfg?.agent_direct);
  if (!direct || direct.enabled !== true) return null;
  const names = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
    : [];
  const writeTools = names(direct.write_tools);
  const hasForceApprovalTools = Object.prototype.hasOwnProperty.call(direct, 'force_approval_tools');
  const hasLegacyUnattendedTools = Object.prototype.hasOwnProperty.call(direct, 'unattended_write_tools');
  const legacyUnattendedTools = new Set(names(direct.unattended_write_tools));
  const forceApprovalTools = hasForceApprovalTools
    ? names(direct.force_approval_tools)
    : hasLegacyUnattendedTools
      ? writeTools.filter((name) => !legacyUnattendedTools.has(name))
      : [];
  return {
    enabled: true,
    write_tools: writeTools,
    force_approval_tools: forceApprovalTools,
  };
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


  if (toolsCfg.agent_direct !== undefined) {
    const direct = record(toolsCfg.agent_direct);
    if (!direct) return 'tools.agent_direct 必须是对象';
    const known = new Set(['enabled', 'write_tools', 'force_approval_tools', 'unattended_write_tools']);
    const unknown = Object.keys(direct).filter((key) => !known.has(key));
    if (unknown.length) return `tools.agent_direct 包含未声明字段: ${unknown.join(',')}`;
    if (typeof direct.enabled !== 'boolean') return 'tools.agent_direct.enabled 必须是布尔值';
    const operationId = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
    const parseNames = (field: 'write_tools' | 'force_approval_tools' | 'unattended_write_tools'): string[] | string => {
      const raw = direct[field];
      if (raw === undefined) return [];
      if (!Array.isArray(raw)) return `tools.agent_direct.${field} 必须是 operationId 数组`;
      const values = raw.map((item) => typeof item === 'string' ? item.trim() : '');
      if (!values.length || values.some((item) => !operationId.test(item))) {
        return `tools.agent_direct.${field} 只允许非空的精确 operationId，不允许通配符`;
      }
      if (new Set(values).size !== values.length) return `tools.agent_direct.${field} 不允许重复值`;
      return values;
    };
    const writes = parseNames('write_tools');
    if (typeof writes === 'string') return writes;
    const forced = parseNames('force_approval_tools');
    if (typeof forced === 'string') return forced;
    const unattended = parseNames('unattended_write_tools');
    if (typeof unattended === 'string') return unattended;
    if (direct.force_approval_tools !== undefined && direct.unattended_write_tools !== undefined) {
      return 'tools.agent_direct.force_approval_tools 与已弃用的 unattended_write_tools 不可同时配置';
    }
    const allowedWrites = new Set(writes);
    const forcedOutside = forced.filter((name) => !allowedWrites.has(name));
    if (forcedOutside.length) return `tools.agent_direct.force_approval_tools 必须是 write_tools 的子集: ${forcedOutside.join(',')}`;
    const unattendedOutside = unattended.filter((name) => !allowedWrites.has(name));
    if (unattendedOutside.length) return `tools.agent_direct.unattended_write_tools 必须是 write_tools 的子集: ${unattendedOutside.join(',')}`;
  }

  return null;
}
