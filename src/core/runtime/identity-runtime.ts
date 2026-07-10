import type { AudiencePolicy, NormalizedPrincipal } from '../contracts/types';

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function clean(v: unknown): string | undefined {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
  return s || undefined;
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(clean).filter(Boolean) as string[];
  const s = clean(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    const s = clean(v);
    if (s) return s;
  }
  return undefined;
}

export function resolvePrincipal(input: {
  metadata?: Record<string, unknown> | null;
  clientAppId?: string | null;
  channel?: string | null;
}): NormalizedPrincipal | null {
  const meta = input.metadata ?? {};
  const p = record(meta.principal) ?? record(meta.subject) ?? record(meta.operator);
  const id = p
    ? firstString(p.id, p.principal_id, p.user_id, p.uid, p.openid, p.userid)
    : firstString(meta.principal_id, meta.principal, meta.subject, meta.user_id, meta.uid, meta.operator_id, meta.wecom_userid, meta.visitor_uid);
  if (!id) return null;
  const tenant = p ? firstString(p.tenant, p.tenant_id, p.org_id, p.workspace_id) : firstString(meta.tenant, meta.tenant_id, meta.org_id, meta.workspace_id);
  const roles = p ? list(p.roles ?? p.role) : list(meta.roles ?? meta.role);
  const audience = p ? firstString(p.audience, p.kind, p.type) : firstString(meta.audience, meta.principal_type, meta.user_type);
  return {
    id: id.slice(0, 128),
    ...(tenant ? { tenant: tenant.slice(0, 128) } : {}),
    roles: roles.map((r) => r.slice(0, 64)),
    ...(audience ? { audience: audience.slice(0, 64) } : {}),
    ...(input.channel ? { channel: input.channel.slice(0, 128) } : {}),
    ...(input.clientAppId ? { client_app_id: input.clientAppId.slice(0, 128) } : {}),
  };
}

export function principalKey(p: NormalizedPrincipal | null): string | null {
  if (!p) return null;
  return [p.tenant ? `t:${p.tenant}` : '', `p:${p.id}`].filter(Boolean).join('|').slice(0, 191);
}

export function normalizeAudiencePolicy(v: unknown): AudiencePolicy | undefined {
  const r = record(v);
  if (!r || !Object.keys(r).length) return undefined;
  const out: AudiencePolicy = {};
  if (r.enabled !== undefined) out.enabled = r.enabled !== false;
  if (r.auto !== undefined) out.auto = r.auto === true;
  if (r.anonymous !== undefined) out.anonymous = r.anonymous === true;
  const priority = Number(r.priority);
  if (Number.isFinite(priority)) out.priority = Math.max(-1000, Math.min(1000, Math.round(priority)));
  for (const key of ['keywords', 'clients', 'channels', 'tenants', 'roles', 'principals', 'audiences'] as const) {
    const xs = list(r[key]);
    if (xs.length) out[key] = xs.slice(0, 100);
  }
  return Object.keys(out).length ? out : undefined;
}

export function validateAudiencePolicy(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const raw = record(v);
  if (!raw) return 'audience 必须是对象';
  if (!Object.keys(raw).length) return null;
  const p = normalizeAudiencePolicy(v);
  if (!p) return 'audience 必须是非空对象';
  if (p.priority !== undefined && !Number.isInteger(p.priority)) return 'audience.priority 必须是整数';
  for (const key of ['keywords', 'clients', 'channels', 'tenants', 'roles', 'principals', 'audiences'] as const) {
    if ((v as Record<string, unknown>)[key] !== undefined && !Array.isArray((v as Record<string, unknown>)[key]) && typeof (v as Record<string, unknown>)[key] !== 'string') {
      return `audience.${key} 必须是字符串或字符串数组`;
    }
  }
  return null;
}

function hasAny(allowed: string[] | undefined, actual: string[] | string | undefined): boolean {
  if (!allowed?.length) return true;
  if (allowed.includes('*')) return true;
  const xs = Array.isArray(actual) ? actual : actual ? [actual] : [];
  return xs.some((x) => allowed.includes(x));
}

export function audienceAllows(policy: AudiencePolicy | undefined, principal: NormalizedPrincipal | null): { ok: boolean; reason?: string } {
  if (!policy || policy.enabled === false) return { ok: true };
  if (!principal) return policy.anonymous === true ? { ok: true } : { ok: false, reason: 'route_requires_principal' };
  if (!hasAny(policy.clients, principal.client_app_id)) return { ok: false, reason: 'client_not_allowed' };
  if (!hasAny(policy.channels, principal.channel)) return { ok: false, reason: 'channel_not_allowed' };
  if (!hasAny(policy.tenants, principal.tenant)) return { ok: false, reason: 'tenant_not_allowed' };
  if (!hasAny(policy.roles, principal.roles)) return { ok: false, reason: 'role_not_allowed' };
  if (!hasAny(policy.principals, principal.id)) return { ok: false, reason: 'principal_not_allowed' };
  if (!hasAny(policy.audiences, principal.audience)) return { ok: false, reason: 'audience_not_allowed' };
  return { ok: true };
}
