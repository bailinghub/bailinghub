import type { ToolOutcome, ToolOutcomeSideEffect, ToolRateLimit, ToolRateLimitWindow, ToolRisk } from './tool-definition';

const RATE_LIMIT_WINDOWS = new Set<ToolRateLimitWindow>(['1s', '1m', '1h', '1d']);
const OUTCOME_SIDE_EFFECTS = new Set<ToolOutcomeSideEffect>(['none', 'read', 'write', 'notify', 'external']);

export const AGENT_CAPABILITY_KEY = 'x-agent-capability';

export interface ToolAnnotations {
  present: boolean;
  enabled: boolean;
  scope: string;
  riskLevel: unknown;
  confirmRequired: boolean;
  confirmWhen: unknown;
  rateLimit: ToolRateLimit | undefined;
  rateLimitPerMin: number;
  requiresSubject: boolean;
  sensitive: boolean;
  readonly: boolean | null;
  idempotent: boolean | null;
  timeoutMs: number;
  whenToUse: string;
  returns: string;
  examples: unknown[];
  confirmPrompt: string;
  context: string[];
  outcome: ToolOutcome | undefined;
  extensions: Record<string, unknown>;
}

export function toolAnnotationsOf(op: Record<string, unknown>): ToolAnnotations {
  const cap = record(op[AGENT_CAPABILITY_KEY]);
  const execution = record(cap?.['execution']);
  const subject = record(cap?.['subject']);
  const risk = record(cap?.['risk']);
  const approval = record(cap?.['approval']);
  const audit = record(cap?.['audit']);
  const guidance = record(cap?.['guidance']);
  const outcome = record(cap?.['outcome']);
  const rateLimit = parseRateLimit(execution?.['rate_limit']);

  return {
    present: !!cap,
    enabled: cap?.['enabled'] === true,
    scope: String(cap?.['scope'] ?? '').trim(),
    riskLevel: risk?.['level'],
    confirmRequired: approval?.['required'] === true,
    confirmWhen: approval?.['when'],
    rateLimit,
    rateLimitPerMin: rateLimit ? rateLimitToPerMin(rateLimit) : 0,
    requiresSubject: subject?.['required'] === true,
    sensitive: audit?.['sensitive'] === true,
    readonly: execution?.['readonly'] === true ? true : null,
    idempotent: execution?.['idempotent'] === true ? true : null,
    timeoutMs: parseTimeout(execution?.['timeout_ms']),
    whenToUse: String(guidance?.['when_to_use'] ?? '').trim(),
    returns: String(guidance?.['returns'] ?? '').trim(),
    examples: Array.isArray(guidance?.['examples']) ? guidance!['examples'] as unknown[] : [],
    confirmPrompt: String(approval?.['prompt'] ?? '').slice(0, 200),
    context: Array.isArray(guidance?.['context']) ? guidance!['context'].map(String).filter(Boolean).slice(0, 50) : [],
    outcome: parseOutcome(outcome),
    extensions: extensionBagOf(op),
  };
}

export function deriveRisk(explicit: unknown, method: string, readonly: boolean): ToolRisk {
  const v = String(explicit ?? '').toLowerCase();
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return method !== 'GET' && !readonly ? 'medium' : 'low';
}

function parseRateLimit(v: unknown): ToolRateLimit | undefined {
  const r = record(v);
  if (!r) return undefined;
  const count = Number(r['count']);
  const window = String(r['window'] ?? '') as ToolRateLimitWindow;
  if (!Number.isInteger(count) || count <= 0 || !RATE_LIMIT_WINDOWS.has(window)) return undefined;
  return { count, window };
}

function rateLimitToPerMin(v: ToolRateLimit): number {
  if (v.window === '1s') return v.count * 60;
  if (v.window === '1m') return v.count;
  if (v.window === '1h') return Math.max(1, Math.round(v.count / 60));
  return Math.max(1, Math.round(v.count / 1440));
}

function parseTimeout(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  return typeof v === 'number' ? v : Number.NaN;
}

function parseOutcome(v: Record<string, unknown> | null): ToolOutcome | undefined {
  if (!v) return undefined;
  const result = String(v['result'] ?? '').trim();
  const sideEffect = String(v['side_effect'] ?? '') as ToolOutcomeSideEffect;
  if (!result || !OUTCOME_SIDE_EFFECTS.has(sideEffect)) return undefined;
  return { result: result.slice(0, 300), sideEffect };
}

function extensionBagOf(op: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(op)) {
    if (key === AGENT_CAPABILITY_KEY) continue;
    if (!isExtensionKey(key)) continue;
    out[key] = value;
  }
  return out;
}

function isExtensionKey(key: string): boolean {
  return key.startsWith('x-bailing-') || key.startsWith('x-business-');
}

function record(v: unknown): Record<string, unknown> | null {
  return !!v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
