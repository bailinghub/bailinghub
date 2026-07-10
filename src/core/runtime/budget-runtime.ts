import type { Client, Route } from '../contracts/types';

export interface BudgetPolicy {
  enabled: boolean;
  window_hours: number;
  hard_cost_usd?: number;
  hard_tokens?: number;
  soft_cost_usd?: number;
  soft_tokens?: number;
}

export interface BudgetUsage {
  jobs: number;
  cost_usd: number;
  tokens: number;
}

export interface BudgetStoreLike {
  budgetUsageSince(filter: { routeKey?: string; clientAppId?: string; sinceMs: number }): Promise<BudgetUsage>;
}

export interface BudgetDecision {
  ok: boolean;
  scope?: 'route' | 'client';
  reason?: 'cost_exceeded' | 'tokens_exceeded';
  policy?: BudgetPolicy;
  usage?: BudgetUsage;
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function positiveNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function positiveInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function normalizeBudgetPolicy(v: unknown): BudgetPolicy | null {
  const b = record(v);
  if (!b || !Object.keys(b).length) return null;
  const windowHours = positiveInt(b['window_hours'])
    ?? (String(b['window'] ?? '') === 'hour' ? 1 : String(b['window'] ?? '') === 'month' ? 24 * 30 : 24);
  return {
    enabled: b['enabled'] !== false,
    window_hours: Math.min(Math.max(windowHours, 1), 24 * 366),
    hard_cost_usd: positiveNumber(b['hard_cost_usd']),
    hard_tokens: positiveInt(b['hard_tokens']),
    soft_cost_usd: positiveNumber(b['soft_cost_usd']),
    soft_tokens: positiveInt(b['soft_tokens']),
  };
}

export function validateBudgetPolicy(v: unknown, path = 'budget'): string | null {
  if (v === undefined || v === null) return null;
  const b = record(v);
  if (!b) return `${path} 必须是对象`;
  if (!Object.keys(b).length) return null;
  if (b['enabled'] !== undefined && typeof b['enabled'] !== 'boolean') return `${path}.enabled 必须是布尔值`;
  if (b['window'] !== undefined && !['hour', 'day', 'month'].includes(String(b['window']))) return `${path}.window 仅支持 hour/day/month`;
  if (b['window_hours'] !== undefined && !positiveInt(b['window_hours'])) return `${path}.window_hours 必须是正整数`;
  for (const k of ['hard_cost_usd', 'soft_cost_usd']) {
    if (b[k] !== undefined && !positiveNumber(b[k])) return `${path}.${k} 必须是正数`;
  }
  for (const k of ['hard_tokens', 'soft_tokens']) {
    if (b[k] !== undefined && !positiveInt(b[k])) return `${path}.${k} 必须是正整数`;
  }
  return null;
}

export function budgetThresholdExceeded(policy: BudgetPolicy, usage: BudgetUsage): BudgetDecision {
  if (!policy.enabled) return { ok: true };
  if (policy.hard_cost_usd !== undefined && usage.cost_usd >= policy.hard_cost_usd) {
    return { ok: false, reason: 'cost_exceeded', policy, usage };
  }
  if (policy.hard_tokens !== undefined && usage.tokens >= policy.hard_tokens) {
    return { ok: false, reason: 'tokens_exceeded', policy, usage };
  }
  return { ok: true };
}

export async function checkLaunchBudget(input: {
  route: Route | null;
  client: Client | null;
  store: BudgetStoreLike | null | undefined;
  nowMs?: number;
}): Promise<BudgetDecision> {
  if (!input.store) return { ok: true };
  const nowMs = input.nowMs ?? Date.now();
  const checks: Array<{ scope: 'route' | 'client'; key: string; policy: BudgetPolicy }> = [];
  const routePolicy = normalizeBudgetPolicy(input.route?.budget);
  if (input.route && routePolicy) checks.push({ scope: 'route', key: input.route.route_key, policy: routePolicy });
  const clientPolicy = normalizeBudgetPolicy(input.client?.budget);
  if (input.client && clientPolicy) checks.push({ scope: 'client', key: input.client.app_id, policy: clientPolicy });

  for (const c of checks) {
    const sinceMs = nowMs - c.policy.window_hours * 60 * 60 * 1000;
    const usage = await input.store.budgetUsageSince(c.scope === 'route'
      ? { routeKey: c.key, sinceMs }
      : { clientAppId: c.key, sinceMs });
    const decision = budgetThresholdExceeded(c.policy, usage);
    if (!decision.ok) return { ...decision, scope: c.scope };
  }
  return { ok: true };
}
