import type { Route, SessionPolicy, TargetKind } from '../contracts/types';
import { validateRouteToolsConfig, type ToolProviderExists } from './tools-config';
import { normalizeTargetConfig, validateTargetConfig } from './target-config';
import { validateBudgetPolicy } from '../runtime/budget-runtime';
import { normalizeAudiencePolicy, validateAudiencePolicy } from '../runtime/identity-runtime';

export interface RouteConfigDeps {
  targetExists: (target: string) => boolean | Promise<boolean>;
  targetNeedsProject: (target: string) => boolean;
  toolProviderExists?: ToolProviderExists;
}

export interface RouteConfigDefaults {
  defaultProfile: string;
  defaultTarget?: TargetKind;
}

export type RouteUpsert = Route;

export interface RouteDeliveryConfig {
  type: string;
  url?: string;
  channel?: string;
  to?: string;
  to_field?: string;
  [key: string]: unknown;
}

export interface RouteKnowledgeConfig {
  kb_ids: string[];
  top_k: number;
  min_score: number;
  inject: 'chunk' | 'doc';
  max_docs: number;
  page_boost: boolean;
  [key: string]: unknown;
}

export interface RouteRetryConfig {
  max: number;
  backoff_ms: number;
}

const SESSION_POLICIES: SessionPolicy[] = ['new', 'fixed', 'per_key', 'passthrough'];
const KNOWLEDGE_INJECT_MODES = ['chunk', 'doc'];

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function nonEmptyRecord(v: unknown): Record<string, unknown> | undefined {
  const r = record(v);
  return r && Object.keys(r).length ? r : undefined;
}

function cleanString(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

function intInRange(v: unknown, path: string, min: number, max: number): string | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return `${path} 必须是 ${min}..${max} 的整数`;
  return null;
}

function numInRange(v: unknown, path: string, min: number, max: number): string | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return `${path} 必须是 ${min}..${max} 的数字`;
  return null;
}

function boolIfPresent(v: unknown, path: string): string | null {
  return v === undefined || typeof v === 'boolean' ? null : `${path} 必须是布尔值`;
}

function intValue(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

function numValue(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function validateDeliveryConfig(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const d = record(v);
  if (!d) return 'delivery 必须是对象';
  if (!Object.keys(d).length) return null;
  const type = cleanString(d.type);
  if (!type) return 'delivery.type 必填';
  if (type === 'webhook') {
    if (!cleanString(d.url)) return 'delivery.type=webhook 时 delivery.url 必填';
    return null;
  }
  if (type === 'none') return null;
  if (type === 'channel') {
    if (!cleanString(d.channel)) return 'delivery.type=channel 时 delivery.channel 必填';
    if (!cleanString(d.to) && !cleanString(d.to_field)) return 'delivery.type=channel 时 delivery.to 或 delivery.to_field 至少填一个';
    return null;
  }
  if (!cleanString(d.to) && !cleanString(d.to_field)) return `delivery.type=${type} 时 delivery.to 或 delivery.to_field 至少填一个`;
  return null;
}

function validateKnowledgeConfig(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const k = record(v);
  if (!k) return 'knowledge 必须是对象';
  if (!Object.keys(k).length) return null;
  const kbIds = Array.isArray(k.kb_ids) ? k.kb_ids.map((x) => String(x).trim()).filter(Boolean) : [];
  if (!cleanString(k.kb_id) && !kbIds.length) return 'knowledge.kb_id 或 knowledge.kb_ids 至少填一个';
  if (k.kb_ids !== undefined && (!Array.isArray(k.kb_ids) || !kbIds.length)) return 'knowledge.kb_ids 必须是非空数组';
  const topKErr = intInRange(k.top_k, 'knowledge.top_k', 1, 20);
  if (topKErr) return topKErr;
  const minScoreErr = numInRange(k.min_score, 'knowledge.min_score', 0, 1);
  if (minScoreErr) return minScoreErr;
  if (k.inject !== undefined && !KNOWLEDGE_INJECT_MODES.includes(String(k.inject))) {
    return `knowledge.inject 仅支持 ${KNOWLEDGE_INJECT_MODES.join(' / ')}`;
  }
  const maxDocsErr = intInRange(k.max_docs, 'knowledge.max_docs', 1, 20);
  if (maxDocsErr) return maxDocsErr;
  return boolIfPresent(k.page_boost, 'knowledge.page_boost');
}

function validateRetryConfig(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const r = record(v);
  if (!r) return 'retry 必须是对象';
  if (!Object.keys(r).length) return null;
  return intInRange(r.max, 'retry.max', 0, 5)
    ?? intInRange(r.backoff_ms, 'retry.backoff_ms', 500, 300_000);
}

function validateMemoryConfig(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const m = record(v);
  if (!m) return 'memory 必须是对象';
  if (!Object.keys(m).length) return null;
  return intInRange(m.recent_messages, 'memory.recent_messages', 1, 50)
    ?? intInRange(m.recent_budget_chars, 'memory.recent_budget_chars', 200, 40_000)
    ?? intInRange(m.per_message_chars, 'memory.per_message_chars', 50, 12_000)
    ?? boolIfPresent(m.summary_enabled, 'memory.summary_enabled')
    ?? intInRange(m.summary_trigger_chars, 'memory.summary_trigger_chars', 500, 40_000)
    ?? intInRange(m.summary_keep_recent, 'memory.summary_keep_recent', 0, 40)
    ?? intInRange(m.summary_max_chars, 'memory.summary_max_chars', 200, 8000);
}

export async function validateRouteConfig(input: Partial<Route>, deps: RouteConfigDeps, defaults: RouteConfigDefaults): Promise<string | null> {
  const routeKey = cleanString(input.route_key);
  if (!routeKey) return 'route_key 必填';
  if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(routeKey)) return 'route_key 仅限字母/数字/点/中划线/下划线/冒号，且最长 128 位';

  const target = cleanString(input.target) ?? defaults.defaultTarget ?? 'llm';
  if (!(await deps.targetExists(target))) return `未知 target: ${target}（先在「调度目标」注册）`;
  if (deps.targetNeedsProject(target) && !cleanString(input.project)) return `target ${target} 需要 project`;

  const targetConfigErr = validateTargetConfig(target, input.target_config);
  if (targetConfigErr) return targetConfigErr;

  const policy = (cleanString(input.session_policy) ?? 'new') as SessionPolicy;
  if (!SESSION_POLICIES.includes(policy)) return `session_policy 仅支持 ${SESSION_POLICIES.join(' / ')}`;
  if (policy === 'fixed' && !cleanString(input.session_fixed_id)) return 'session_policy=fixed 时 session_fixed_id 必填';
  if (policy === 'per_key' && !cleanString(input.session_key_field)) return 'session_policy=per_key 时 session_key_field 必填';

  return validateDeliveryConfig(input.delivery)
    ?? validateKnowledgeConfig(input.knowledge)
    ?? validateRetryConfig(input.retry)
    ?? validateMemoryConfig(input.memory)
    ?? validateAudiencePolicy(input.audience)
    ?? validateBudgetPolicy(input.budget)
    ?? await validateRouteToolsConfig(input.tools, deps.toolProviderExists);
}

export function normalizeRouteConfig(input: Partial<Route>, defaults: RouteConfigDefaults): RouteUpsert {
  const routeKey = cleanString(input.route_key)!;
  const target = cleanString(input.target) ?? defaults.defaultTarget ?? 'llm';
  const targetConfig = normalizeTargetConfig(target, input.target_config);
  const sessionPolicy = (cleanString(input.session_policy) ?? 'new') as SessionPolicy;
  const tools = nonEmptyRecord(input.tools);
  return {
    route_key: routeKey,
    name: cleanString(input.name) ?? routeKey,
    enabled: input.enabled !== false,
    target,
    target_config: targetConfig,
    project: cleanString(input.project),
    profile: cleanString(input.profile) ?? defaults.defaultProfile,
    permission: cleanString(input.permission),
    session_policy: sessionPolicy,
    session_fixed_id: cleanString(input.session_fixed_id),
    session_key_field: cleanString(input.session_key_field),
    default_callback_url: cleanString(input.default_callback_url),
    delivery: nonEmptyRecord(input.delivery),
    knowledge: nonEmptyRecord(input.knowledge),
    retry: nonEmptyRecord(input.retry),
    tools,
    audience: normalizeAudiencePolicy(input.audience),
    memory: nonEmptyRecord(input.memory),
    budget: nonEmptyRecord(input.budget),
    description: input.description,
  };
}

export function routeDeliveryConfig(v: unknown): RouteDeliveryConfig | null {
  const d = record(v);
  const type = cleanString(d?.type);
  return d && type ? { ...d, type } as RouteDeliveryConfig : null;
}

export function routeKnowledgeConfig(v: unknown): RouteKnowledgeConfig | null {
  const k = record(v);
  if (!k) return null;
  const kbIds = Array.isArray(k.kb_ids)
    ? k.kb_ids.map((x) => String(x).trim()).filter(Boolean)
    : (cleanString(k.kb_id) ? [cleanString(k.kb_id)!] : []);
  if (!kbIds.length) return null;
  return {
    ...k,
    kb_ids: kbIds,
    top_k: intValue(k.top_k, 5, 1, 20),
    min_score: numValue(k.min_score, 0.35, 0, 1),
    inject: k.inject === 'doc' ? 'doc' : 'chunk',
    max_docs: intValue(k.max_docs, 4, 1, 20),
    page_boost: k.page_boost === true,
  } as RouteKnowledgeConfig;
}

export function routeRetryConfig(v: unknown): RouteRetryConfig {
  const r = record(v) ?? {};
  return {
    max: intValue(r.max, 0, 0, 5),
    backoff_ms: intValue(r.backoff_ms, 5000, 500, 300_000),
  };
}

export async function prepareRouteConfig(input: Partial<Route>, deps: RouteConfigDeps, defaults: RouteConfigDefaults): Promise<{ ok: true; route: RouteUpsert } | { ok: false; error: string }> {
  const error = await validateRouteConfig(input, deps, defaults);
  return error ? { ok: false, error } : { ok: true, route: normalizeRouteConfig(input, defaults) };
}
