import type { AudiencePolicy, Client, NormalizedPrincipal, Route } from '../contracts/types';
import { audienceAllows } from './identity-runtime';

export interface AutoRouteCandidate {
  route: Route;
  score: number;
  reasons: string[];
}

export interface AutoRouteResult {
  ok: boolean;
  route?: Route;
  candidates: AutoRouteCandidate[];
  error?: string;
}

export interface AutoRoutePreviewRow {
  route_key: string;
  route_name: string;
  enabled: boolean;
  auto_enabled: boolean;
  client_allowed: boolean;
  audience_allowed: boolean;
  audience_reason?: string;
  score: number;
  reasons: string[];
  selected: boolean;
  rejected_reason?: string;
}

export interface AutoRoutePreviewResult {
  ok: boolean;
  selected_route?: string;
  error?: string;
  candidates: AutoRouteCandidate[];
  rows: AutoRoutePreviewRow[];
}

function words(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v ?? '').trim();
  return s ? [s] : [];
}

function containsAny(text: string, xs: string[] | undefined): { score: number; hits: string[] } {
  const hits = (xs ?? []).filter((x) => x && text.includes(x.toLowerCase()));
  return { score: hits.length * 10, hits };
}

function clientAllows(client: Client | null, routeKey: string): boolean {
  if (!client) return true;
  return client.allowed_routes.includes('*') || client.allowed_routes.includes(routeKey);
}

function policy(route: Route): AudiencePolicy | undefined {
  return route.audience;
}

function routeAutoEnabled(p: AudiencePolicy | undefined): boolean {
  return p?.auto === true || !!p?.keywords?.length;
}

export function selectAutoRoute(input: {
  routes: Route[];
  text: string;
  metadata?: Record<string, unknown>;
  client?: Client | null;
  principal: NormalizedPrincipal | null;
  channel?: string;
}): AutoRouteResult {
  const hay = [
    input.text,
    ...Object.entries(input.metadata ?? {}).flatMap(([k, v]) => [k, typeof v === 'string' || typeof v === 'number' ? String(v) : '']),
  ].join(' ').toLowerCase();
  const candidates: AutoRouteCandidate[] = [];
  for (const route of input.routes) {
    if (!route.enabled || !clientAllows(input.client ?? null, route.route_key)) continue;
    const p = policy(route);
    if (!routeAutoEnabled(p)) continue;
    const allowed = audienceAllows(p, input.principal);
    if (!allowed.ok) continue;
    const kw = containsAny(hay, p?.keywords);
    const nameHits = containsAny(hay, words(route.route_key).concat(words(route.name)));
    const reasons: string[] = [];
    if (kw.hits.length) reasons.push(`keywords:${kw.hits.join(',')}`);
    if (nameHits.hits.length) reasons.push(`route:${nameHits.hits.join(',')}`);
    if (input.principal?.tenant && p?.tenants?.includes(input.principal.tenant)) reasons.push('tenant');
    if (input.principal?.audience && p?.audiences?.includes(input.principal.audience)) reasons.push('audience');
    if (input.principal?.roles.some((r) => p?.roles?.includes(r))) reasons.push('role');
    if (input.client?.app_id && p?.clients?.includes(input.client.app_id)) reasons.push('client');
    const base = (p?.priority ?? 0) + kw.score + nameHits.score + reasons.length;
    const score = p?.auto === true ? base + 1 : base;
    if (score > 0) candidates.push({ route, score, reasons: reasons.length ? reasons : ['auto'] });
  }
  candidates.sort((a, b) => b.score - a.score || a.route.route_key.localeCompare(b.route.route_key));
  if (!candidates.length) return { ok: false, candidates, error: 'route_auto_no_match' };
  if (candidates.length > 1 && candidates[0]!.score === candidates[1]!.score) {
    return { ok: false, candidates: candidates.slice(0, 5), error: 'route_auto_ambiguous' };
  }
  return { ok: true, route: candidates[0]!.route, candidates: candidates.slice(0, 5) };
}

export function previewAutoRoute(input: {
  routes: Route[];
  text: string;
  metadata?: Record<string, unknown>;
  client?: Client | null;
  principal: NormalizedPrincipal | null;
  channel?: string;
}): AutoRoutePreviewResult {
  const picked = selectAutoRoute(input);
  const candidateMap = new Map(picked.candidates.map((c) => [c.route.route_key, c]));
  const rows: AutoRoutePreviewRow[] = input.routes.map((route) => {
    const p = policy(route);
    const autoEnabled = routeAutoEnabled(p);
    const clientAllowed = clientAllows(input.client ?? null, route.route_key);
    const audience = audienceAllows(p, input.principal);
    const c = candidateMap.get(route.route_key);
    let rejected: string | undefined;
    if (!route.enabled) rejected = 'route_disabled';
    else if (!autoEnabled) rejected = 'auto_not_enabled';
    else if (!clientAllowed) rejected = 'client_not_allowed';
    else if (!audience.ok) rejected = audience.reason ?? 'audience_not_allowed';
    else if (!c) rejected = 'score_zero_or_lower';
    return {
      route_key: route.route_key,
      route_name: route.name,
      enabled: route.enabled,
      auto_enabled: autoEnabled,
      client_allowed: clientAllowed,
      audience_allowed: audience.ok,
      ...(audience.reason ? { audience_reason: audience.reason } : {}),
      score: c?.score ?? 0,
      reasons: c?.reasons ?? [],
      selected: picked.ok && picked.route?.route_key === route.route_key,
      ...(rejected ? { rejected_reason: rejected } : {}),
    };
  }).sort((a, b) => Number(b.selected) - Number(a.selected) || b.score - a.score || a.route_key.localeCompare(b.route_key));
  return {
    ok: picked.ok,
    ...(picked.route ? { selected_route: picked.route.route_key } : {}),
    ...(picked.error ? { error: picked.error } : {}),
    candidates: picked.candidates,
    rows,
  };
}
