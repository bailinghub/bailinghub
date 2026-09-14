import type { ToolDefinition, ToolRateLimitWindow } from './tool-definition';

export type ToolRateLimitPolicy = { mode: 'inherit' | 'disabled' } | { mode: 'custom'; count: number; window: ToolRateLimitWindow };
export interface ToolRateLimitPolicies {
  default: ToolRateLimitPolicy;
  overrides: Record<string, ToolRateLimitPolicy>;
}
export interface RateLimitRequest { bucket: string; limit: number; windowSec: number }
export interface RateLimitDecision { limited: boolean; bucket?: string; retryAfterMs?: number }
export const RATE_WINDOW_SECONDS = { '1s': 1, '1m': 60, '1h': 3600, '1d': 86400 } as const;

/** Omitted configuration preserves the published business declaration. Never rewrite the spec. */
export function normalizeToolRateLimitPolicies(raw: unknown): ToolRateLimitPolicies {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('tool_rate_limits 必须是对象');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['default', 'overrides'].includes(key))) throw new Error('tool_rate_limits 包含未知字段');
  const policy = (v: unknown): ToolRateLimitPolicy => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('单工具限额策略必须是对象');
    const p = v as Record<string, unknown>;
    if (p.mode === 'inherit' || p.mode === 'disabled') {
      if (Object.keys(p).some((key) => key !== 'mode')) throw new Error('继承或关闭策略不应包含自定义限额');
      return { mode: p.mode };
    }
    if (p.mode !== 'custom' || !Number.isSafeInteger(p.count) || Number(p.count) < 1 || Number(p.count) > 1_000_000
      || typeof p.window !== 'string' || !Object.hasOwn(RATE_WINDOW_SECONDS, p.window)
      || Object.keys(p).some((key) => !['mode', 'count', 'window'].includes(key))) {
      throw new Error('自定义限额需为 1–1000000 的整数，窗口为 1s/1m/1h/1d');
    }
    return { mode: 'custom', count: Number(p.count), window: p.window as ToolRateLimitWindow };
  };
  const overrides = value.overrides ?? {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).length > 1000) throw new Error('单工具覆盖最多 1000 项');
  const entries = Object.entries(overrides).map(([name, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error('单工具覆盖需使用有效的工具名');
    return [name, policy(v)] as const;
  });
  return { default: policy(value.default ?? { mode: 'inherit' }), overrides: Object.fromEntries(entries) };
}

export function effectiveToolRateLimit(tool: Pick<ToolDefinition, 'name' | 'rateLimit' | 'rateLimitPerMin'>, policies?: ToolRateLimitPolicies) {
  const override = policies?.overrides && Object.hasOwn(policies.overrides, tool.name) ? policies.overrides[tool.name] : undefined;
  const policy = override ?? policies?.default ?? { mode: 'inherit' };
  const source = policy.mode === 'inherit' ? 'declaration' : override ? 'tool_override' : 'provider_default';
  const limit = policy.mode === 'disabled' ? null : policy.mode === 'custom' ? policy
    : tool.rateLimit ?? (tool.rateLimitPerMin > 0 ? { count: tool.rateLimitPerMin, window: '1m' as const } : null);
  return { enabled: !!limit && limit.count > 0, count: limit?.count ?? 0, window: limit?.window ?? null,
    window_sec: limit ? RATE_WINDOW_SECONDS[limit.window] : 0, source, scope: 'tool_provider_shared' as const };
}
