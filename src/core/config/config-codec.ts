import type { PageRule } from '../platform/pagecontext';
import type { AlertRule, Channel, ChatEntry, Client, Credential, ExecutorToken, ProjectReg, Route, StorageBucket, TargetDef, ToolApproval, ToolProvider, TraceSeverity, TraceStage } from '../contracts/types';

const TRACE_STAGES = new Set<TraceStage>(['launch', 'context', 'execution', 'tool', 'approval', 'delivery', 'summary', 'recovery', 'channel', 'config', 'system']);
const TRACE_SEVERITIES = new Set<TraceSeverity>(['info', 'warning', 'error']);

export function traceStageValue(v: unknown): TraceStage {
  const s = String(v ?? '');
  return TRACE_STAGES.has(s as TraceStage) ? s as TraceStage : 'system';
}

export function traceSeverityValue(v: unknown): TraceSeverity {
  const s = String(v ?? '');
  return TRACE_SEVERITIES.has(s as TraceSeverity) ? s as TraceSeverity : 'info';
}

export function dt(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

export function dtAt(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

export function dtIso(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, '');
}

export function rowThreadHead(r: any): any {
  return {
    thread_id: Number(r.thread_id), route_key: r.route_key, route_name: r.route_name ?? r.route_key,
    scope_key: r.scope_key, principal_id: r.principal_id ?? null,
    channel: r.channel ?? null, client_name: r.client_name ?? null, entry_name: r.entry_name ?? null,
    message_count: Number(r.message_count ?? 0), last_preview: r.last_preview ?? '',
    created_at: new Date(r.created_at).toISOString(), last_active_at: new Date(r.last_active_at).toISOString(),
  };
}

export function rowClient(r: any): Client {
  const ar = r.allowed_routes;
  const ac = r.allowed_channels;
  const budget = r.budget ? (typeof r.budget === 'string' ? JSON.parse(r.budget) : r.budget) : undefined;
  return {
    app_id: r.app_id, name: r.name, token: r.token,
    allowed_routes: ar ? (typeof ar === 'string' ? JSON.parse(ar) : ar) : [],
    allowed_channels: ac ? (typeof ac === 'string' ? JSON.parse(ac) : ac) : [],
    rate_limit_per_min: Number(r.rate_limit_per_min ?? 60),
    budget,
    enabled: !!r.enabled, description: r.description ?? undefined,
    last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : undefined,
  };
}

export function rowExecutorToken(r: any): ExecutorToken {
  const at = r.allowed_targets;
  return {
    name: r.name, token: r.token,
    allowed_targets: at ? (typeof at === 'string' ? JSON.parse(at) : at) : [],
    enabled: !!r.enabled,
    last_seen_at: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
    description: r.description ?? undefined,
  };
}

export function rowProject(r: any): ProjectReg {
  return { name: r.name, path: r.path, enabled: !!r.enabled, description: r.description ?? undefined };
}

export function rowRoute(r: any): Route {
  const j = (v: unknown) => (v ? (typeof v === 'string' ? JSON.parse(v) : v) : undefined);
  return {
    route_key: r.route_key, name: r.name, enabled: !!r.enabled,
    target: (r.target ?? 'llm') as Route['target'],
    target_config: j(r.target_config) ?? {},
    project: r.project ?? undefined, profile: r.profile, permission: r.permission ?? undefined,
    session_policy: r.session_policy, session_fixed_id: r.session_fixed_id ?? undefined,
    session_key_field: r.session_key_field ?? undefined, default_callback_url: r.default_callback_url ?? undefined,
    delivery: j(r.delivery), knowledge: j(r.knowledge), retry: j(r.retry), tools: j(r.tools), audience: j(r.audience), memory: j(r.memory), budget: j(r.budget),
    description: r.description ?? undefined,
  };
}

export function rowChatEntry(r: any): ChatEntry {
  const ao = r.allowed_origins;
  return {
    entry_key: r.entry_key, name: r.name, route_key: r.route_key, enabled: !!r.enabled,
    allowed_origins: ao ? (typeof ao === 'string' ? JSON.parse(ao) : ao) : [],
    rate_limit_per_min: Number(r.rate_limit_per_min ?? 20),
    ticket_client: r.ticket_client ?? undefined,
    bucket: r.bucket ?? undefined,
    title: r.title ?? undefined, greeting: r.greeting ?? undefined, color: r.color ?? undefined,
    appearance: r.appearance ? (typeof r.appearance === 'string' ? JSON.parse(r.appearance) : r.appearance) : undefined,
    description: r.description ?? undefined,
  };
}

export function rowPageContext(r: any): PageRule {
  return {
    id: Number(r.id), entry_key: r.entry_key, url_pattern: r.url_pattern,
    page_key: r.page_key ?? undefined, page_name: r.page_name ?? undefined,
    description: r.description ?? undefined, kb_tag: r.kb_tag ?? undefined,
    priority: Number(r.priority ?? 0), enabled: !!r.enabled,
  };
}

export function rowToolApproval(r: any): ToolApproval {
  const intent = parseOptionalJson(r.intent_json);
  return {
    id: Number(r.id), job_id: r.job_id, request_id: r.request_id, provider: r.provider,
    tool: r.tool, scope: r.scope, risk: r.risk,
    policy: r.policy ?? undefined, reason: r.reason ?? undefined,
    method: r.method ?? undefined, path: r.path ?? undefined,
    summary: r.summary ?? undefined,
    args_json: r.args_json ?? undefined, args_hash: r.args_hash,
    intent_json: r.intent_json ?? undefined,
    ...(intent ? { intent } : {}),
    on_behalf_of: r.on_behalf_of ?? undefined,
    status: r.status, decision_id: r.decision_id ?? undefined,
    decided_by: r.decided_by ?? undefined, decision_comment: r.decision_comment ?? undefined,
    decided_at: r.decided_at ? new Date(r.decided_at).toISOString() : undefined,
    used_at: r.used_at ? new Date(r.used_at).toISOString() : undefined,
    created_at: new Date(r.created_at).toISOString(),
  };
}

function parseOptionalJson(v: unknown): Record<string, unknown> | null {
  if (!v) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v !== 'string') return null;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function rowToolProvider(r: any): ToolProvider {
  const authzProbeRaw = r.authz_probe_json
    ? parseOptionalJson(r.authz_probe_json)
    : undefined;
  const authzProbe = authzProbeRaw && typeof authzProbeRaw === 'object' && !Array.isArray(authzProbeRaw)
    ? authzProbeRaw as ToolProvider['authz_probe']
    : undefined;
  return {
    name: r.name, base_url: r.base_url,
    spec_source: (r.spec_source === 'url' ? 'url' : 'inline'),
    spec_url: r.spec_url ?? undefined, spec_json: r.spec_json ?? undefined,
    spec_refreshed_at: r.spec_refreshed_at ? new Date(r.spec_refreshed_at).toISOString() : undefined,
    authz_probe: authzProbe,
    secret: r.secret, log_payload: !!r.log_payload,
    timeout_ms: Number(r.timeout_ms ?? 10000), rate_limit_per_min: Number(r.rate_limit_per_min ?? 120),
    auto_refresh_min: Number(r.auto_refresh_min ?? 0),
    enabled: !!r.enabled, description: r.description ?? undefined,
    embed_credential: r.embed_credential ?? undefined,
    embed_model: r.embed_model ?? undefined,
    embed_dim: r.embed_dim != null ? Number(r.embed_dim) : undefined,
  };
}

export function rowTarget(r: any): TargetDef {
  return {
    name: r.name, kind: (r.kind === 'inhub' ? 'inhub' : 'executor'),
    stateless: !!r.stateless, needs_project: !!r.needs_project,
    timeout_ms: Number(r.timeout_ms ?? 0), enabled: !!r.enabled, description: r.description ?? undefined,
  };
}

export function rowCredential(r: any): Credential {
  return {
    name: r.name, kind: (r.kind ?? 'chat') as Credential['kind'], base_url: r.base_url, api_key: r.api_key,
    default_model: r.default_model ?? undefined, enabled: !!r.enabled, description: r.description ?? undefined,
    last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : undefined,
  };
}

export function rowStorageBucket(r: any): StorageBucket {
  return {
    name: r.name, kind: (r.kind === 'oss' ? 'oss' : r.kind === 's3' ? 's3' : 'cos'),
    region: r.region ?? '', bucket: r.bucket, endpoint: r.endpoint ?? undefined,
    access_key: r.access_key, secret_key: r.secret_key,
    public_base_url: r.public_base_url ?? '', path_prefix: r.path_prefix ?? 'bailing/chat',
    enabled: !!r.enabled, description: r.description ?? undefined,
  };
}

export const CHANNEL_SECRET_KEYS = ['token', 'aes_key', 'secret', 'app_secret', 'encrypt_key', 'verification_token'];

export function mergeChannelSecrets(incoming: Record<string, unknown>, existing?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  for (const k of CHANNEL_SECRET_KEYS) {
    const v = out[k];
    if ((v === undefined || v === null || v === '') && existing && existing[k]) out[k] = existing[k];
  }
  return out;
}

export function rowChannel(r: any): Channel {
  let config: Record<string, unknown> = {};
  try { config = typeof r.config === 'string' ? (r.config ? JSON.parse(r.config) : {}) : (r.config ?? {}); } catch { config = {}; }
  return {
    name: r.name, kind: String(r.kind ?? 'wecom'), route_key: r.route_key,
    config, enabled: !!r.enabled, description: r.description ?? undefined,
  };
}

export function rowAlertRule(r: any): AlertRule {
  let recipients: string[] = [];
  try {
    const v = typeof r.recipients === 'string' ? (r.recipients ? JSON.parse(r.recipients) : []) : (r.recipients ?? []);
    if (Array.isArray(v)) recipients = v.map((x) => String(x));
  } catch {
    recipients = [];
  }
  return {
    id: Number(r.id), event_prefix: String(r.event_prefix ?? ''), channel: r.channel,
    recipients, cooldown_min: Number(r.cooldown_min ?? 60), enabled: !!r.enabled, description: r.description ?? undefined,
  };
}
