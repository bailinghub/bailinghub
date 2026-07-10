import type { ToolEmbedConfig } from '../services/tools-index';
import { compileOpenApiTools } from '../core/contracts/openapi-tools';
import type { ToolDefinition } from '../core/contracts/tool-definition';
import { scopeAllowed } from '../core/contracts/tools';
import { maxToolCalls, routeToolsConfig, toolSourceConfigs, type RouteToolsConfig, type ToolSourceConfig } from '../core/config/tools-config';
import type { Job, Route, ToolProvider } from '../core/contracts/types';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export interface AllowedToolSourceContext {
  provider: ToolProvider;
  allowed: ToolDefinition[];
  sourceCfg: ToolSourceConfig;
  onBehalfOf: string;
  lockedBySubject: number;
}

export interface AllowedToolContext {
  sources: AllowedToolSourceContext[];
  allowed: ToolDefinition[];
  toolsCfg: RouteToolsConfig;
  lockedBySubject: number;
}

/** 主体取数：显式 subject_field 优先，取不到时回落中枢标准字段 visitor_uid，再取不到由渠道派生。 */
export function subjectOf(job: Job, sourceCfg: ToolSourceConfig): string {
  const f = String(sourceCfg.subject_field ?? '');
  const meta = (job.metadata ?? {}) as Record<string, unknown>;
  const explicit = String((f ? meta[f] ?? meta['visitor_uid'] : meta['visitor_uid']) ?? '');
  return explicit || channelSubject(job);
}

/** 渠道入站身份 → 带命名空间的操作主体（没有登录票据/visitor_uid 时的回落）。 */
function channelSubject(job: Job): string {
  const meta = (job.metadata ?? {}) as Record<string, unknown>;
  if (typeof job.source === 'string' && job.source.startsWith('wecom:')) {
    const wxUser = String(meta['wecom_userid'] ?? '').trim();
    if (wxUser) return `wecom:${wxUser}`.slice(0, 191);
  }
  return '';
}

/** 来源会话坐标 `<渠道名>:<收件人>`，随工具调用以 X-Bailing-Conversation 透传给业务。 */
export function conversationAddrOf(job: Job): string {
  if (typeof job.source === 'string' && job.source.startsWith('wecom:')) {
    const channel = job.source.slice('wecom:'.length).trim();
    const recipient = String((job.metadata ?? {})['wecom_userid'] ?? '').trim();
    if (channel && recipient) return `${channel}:${recipient}`.slice(0, 191);
  }
  return '';
}

/** 路由/任务的 tools 配置 → 多工具源 + 已过双闸的聚合工具清单（运行时装配与 claim 派发共用）。 */
export async function resolveAllowedToolsFor(config: ConfigStoreContract | null, job: Job, route: Route | null): Promise<AllowedToolContext | null> {
  const toolsCfg = routeToolsConfig(route?.tools ?? job.dispatch?.tools);
  const sourceCfgs = toolSourceConfigs(toolsCfg);
  if (!toolsCfg || !sourceCfgs.length || !config) return null;
  const resolved = await Promise.all(sourceCfgs.map(async (sourceCfg) => {
    const provider = await config.toolProviders.get(sourceCfg.provider);
    if (!provider) throw new Error(`工具源 ${sourceCfg.provider} 未注册`);
    if (!provider.enabled) throw new Error(`工具源 ${sourceCfg.provider} 已停用`);
    if (!provider.spec_json) throw new Error(`工具源 ${sourceCfg.provider} 无 spec（先刷新/粘贴）`);
    const onBehalfOf = subjectOf(job, sourceCfg);
    const { tools: derived } = compileOpenApiTools(provider.spec_json);
    const scoped = derived.filter((t) => scopeAllowed(t.scope, sourceCfg.allow));
    const lockedBySubject = scoped.filter((t) => t.requiresSubject && !onBehalfOf).length;
    const allowed = scoped.filter((t) => !t.requiresSubject || !!onBehalfOf)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { provider, sourceCfg, onBehalfOf, scoped, allowed, lockedBySubject };
  }));

  const owners = new Map<string, string>();
  for (const source of resolved) {
    for (const tool of source.scoped) {
      const owner = owners.get(tool.name);
      if (owner && owner !== source.provider.name) {
        throw new Error(`工具名冲突 ${tool.name}：同时来自 ${owner} 与 ${source.provider.name}；请在工具声明中使用全局唯一 operationId`);
      }
      owners.set(tool.name, source.provider.name);
    }
  }

  const sources: AllowedToolSourceContext[] = resolved
    .filter((source) => source.allowed.length || source.lockedBySubject)
    .map(({ scoped: _scoped, ...source }) => source);
  const allowed = sources.flatMap((source) => source.allowed);
  const lockedBySubject = sources.reduce((sum, source) => sum + source.lockedBySubject, 0);
  if (!allowed.length && !lockedBySubject) return null;
  return { sources, allowed, toolsCfg, lockedBySubject };
}

export function maxCallsOf(toolsCfg: RouteToolsConfig | unknown): number {
  return maxToolCalls(toolsCfg);
}

/** 工具源的检索坐标系（embedding 凭证/模型/维度）；三者齐备才返回。 */
export function embedConfigOf(p: { embed_credential?: string; embed_model?: string; embed_dim?: number }): ToolEmbedConfig | null {
  if (!p.embed_credential || !p.embed_model || !p.embed_dim) return null;
  return { credential: p.embed_credential, model: p.embed_model, dim: p.embed_dim };
}

/** 路由级检索力度：tools.retrieval = { enabled?, min_score?, max_tools? }。 */
export function retrievalOptsOf(sourceCfg: ToolSourceConfig): { enabled: boolean; minScore: number; maxTools: number } {
  const r = (sourceCfg.retrieval && typeof sourceCfg.retrieval === 'object' ? sourceCfg.retrieval : {}) as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    minScore: Math.min(Math.max(Number(r['min_score'] ?? 0.3) || 0.3, 0), 1),
    maxTools: Math.min(Math.max(Number(r['max_tools'] ?? 15) || 15, 1), 40),
  };
}
