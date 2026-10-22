import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AgentClientRuntimeDeps } from './agent-client-runtime';
import { AgentToolApiError, resolveAgentRouteFor, type AgentToolAuthContext } from './agent-tool-invocations';
import { routeAgentClientConfig, routeKnowledgeConfig } from '../core/config/route-config';
import { assertAgentLegacyTaskAllowedFor, resolveAgentTaskRunFor } from './agent-task-control';
import { assertTaskCanDispatch } from '../core/runtime/agent-task-control';
import { requireServerToken } from '../core/platform/server-token';
import type { Route } from '../core/contracts/types';
import type { AgentKnowledgeDocument } from '../services/kb';

export const AGENT_KNOWLEDGE_PROTOCOL = 'bailing.agent-knowledge.v1';
export const AGENT_KNOWLEDGE_LIMITS = Object.freeze({ search_max_results: 3, search_max_bytes: 4096,
  read_default_bytes: 16384, read_max_bytes: 32768, reference_ttl_seconds: 300, read_chain_max_bytes: 131072 });

export interface AgentKnowledgeSearchInput { query: string; limit?: number; run_id?: string }
export interface AgentKnowledgeReadInput { ref: string; run_id?: string; cursor?: string; max_bytes?: number }

interface ReferencePayload {
  v: 1; c: string; s: string; p: string; w: string; g: string; k: string; d: number; r: string; e: number; u?: string;
}
interface CursorPayload { v: 1; f: string; r: string; o: number; e: number }
type JsonRecord = Record<string, unknown>;

function stable(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as JsonRecord)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function hash(value: unknown): string { return createHash('sha256').update(stable(value), 'utf8').digest('hex'); }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function now(deps: AgentClientRuntimeDeps): number { return new Date(deps.toolProxyDeps.now()).getTime(); }
function invalid(message = 'The knowledge reference is invalid; search again.'): never {
  throw new AgentToolApiError(400, 'knowledge_reference_invalid', message);
}
function changed(): never { throw new AgentToolApiError(409, 'knowledge_changed', 'The referenced knowledge changed; search again.'); }
function scopeChanged(): never { throw new AgentToolApiError(409, 'knowledge_scope_changed', 'The knowledge scope changed; search again.'); }
function unavailable(): never { throw new AgentToolApiError(503, 'knowledge_unavailable', 'Knowledge is unavailable. Try searching later.'); }
function checkRunId(value: string | undefined): string | undefined {
  if (value !== undefined && (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))) {
    throw new AgentToolApiError(400, 'invalid_request', 'run_id must be a UUID.');
  }
  return value;
}
function principalHash(auth: AgentToolAuthContext): string {
  return hash({ principal: auth.session.principal, on_behalf_of: auth.session.on_behalf_of });
}
function scopeRevision(route: Route): string {
  // profile_revision deliberately exposes only the KB count. This separate revision binds
  // the exact server-owned sources, so swapping two equally sized KB sets invalidates refs.
  return hash({ protocol: AGENT_KNOWLEDGE_PROTOCOL, route: route.route_key, knowledge: route.knowledge ?? null,
    enabled: route.enabled, agent_client: routeAgentClientConfig(route), audience: route.audience ?? null });
}

async function authorize(deps: AgentClientRuntimeDeps, original: AgentToolAuthContext, routeKey: string, runId?: string,
  options: { preparing?: boolean; capabilities?: boolean } = {}) {
  const store = deps.toolProxyDeps.configStore;
  // HTTP authentication already checks the bearer. Recheck mutable authorization after
  // asynchronous embedding / storage reads without retaining or logging the bearer.
  const client = store?.clients?.get ? await store.clients.get(original.client.app_id) : original.client;
  const session = store?.agentAuth?.getBusinessSession
    ? await store.agentAuth.getBusinessSession(original.client.app_id, original.session.session_id) : original.session;
  if (!client?.enabled || !session || session.revoked_at
    || new Date(session.access_expires_at).getTime() <= now(deps)
    || new Date(session.refresh_expires_at).getTime() <= now(deps)
    || session.session_id !== original.session.session_id || session.client_app_id !== original.client.app_id
    || principalHash({ client, session }) !== principalHash(original)) {
    throw new AgentToolApiError(401, 'unauthorized', 'The Agent Session is unavailable.');
  }
  const auth = { client, session };
  const route = await resolveAgentRouteFor(deps.toolProxyDeps, auth, routeKey);
  if (!routeAgentClientConfig(route)) throw new AgentToolApiError(403, 'agent_client_disabled', 'Agent Client Runtime is not enabled for this route.');
  if (runId) {
    const run = await store?.agentClientRuntime?.getRun(runId, session.session_id, client.app_id);
    if (!run || run.route_key !== routeKey || (run.status !== 'context_ready' && !(options.preparing && run.status === 'preparing')) || run.completed_at) {
      throw new AgentToolApiError(404, 'run_not_found', 'The active run was not found for this Agent Session and route.');
    }
    const task = await resolveAgentTaskRunFor(store, auth, runId, routeKey, !options.preparing);
    if (task) assertTaskCanDispatch(task, deps.toolProxyDeps.now());
  } else if (!options.capabilities) await assertAgentLegacyTaskAllowedFor(store, session.session_id);
  return { auth, route, cfg: routeKnowledgeConfig(route.knowledge), revision: scopeRevision(route) };
}

function signingKey(deps: AgentClientRuntimeDeps, kind: 'ref' | 'cursor'): Buffer {
  try {
    return createHmac('sha256', requireServerToken(deps.toolProxyDeps.cfg.server?.token ?? '', '签署 Agent 知识引用'))
      .update(`bailing.agent-knowledge.${kind}.key.v1`).digest();
  } catch { return unavailable(); }
}
function sign(deps: AgentClientRuntimeDeps, kind: 'ref' | 'cursor', payload: ReferencePayload | CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const prefix = kind === 'ref' ? 'bkr1' : 'bkc1';
  const signature = createHmac('sha256', signingKey(deps, kind)).update(`${prefix}.${body}`).digest('base64url');
  return `${prefix}.${body}.${signature}`;
}
function open(deps: AgentClientRuntimeDeps, kind: 'ref' | 'cursor', token: string): JsonRecord {
  if (typeof token !== 'string' || token.length > 2048) return invalid();
  const parts = token.split('.'); const prefix = kind === 'ref' ? 'bkr1' : 'bkc1';
  if (parts.length !== 3 || parts[0] !== prefix || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2]!)) return invalid();
  const expected = createHmac('sha256', signingKey(deps, kind)).update(`${prefix}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2]!, 'base64url');
  if (actual.toString('base64url') !== parts[2] || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalid();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')); } catch { return invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const record = value as JsonRecord;
  if (record.v !== 1 || !Number.isSafeInteger(record.e)) return invalid();
  if (Number(record.e) <= now(deps)) throw new AgentToolApiError(410, 'knowledge_reference_expired', 'The knowledge reference expired; search again.');
  if (Number(record.e) > now(deps) + AGENT_KNOWLEDGE_LIMITS.reference_ttl_seconds * 1000) return invalid();
  return record;
}
function prefixChars(value: string, maximum: number): string {
  let end = Math.min(value.length, maximum);
  if (end > 0 && end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
  return value.slice(0, end);
}
function prefixBytes(value: string, maximum: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximum) return value;
  let low = 0; let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(prefixChars(value, middle), 'utf8') <= maximum) low = middle;
    else high = middle - 1;
  }
  return prefixChars(value, low);
}

export async function getAgentKnowledgeCapabilitiesFor(deps: AgentClientRuntimeDeps, auth: AgentToolAuthContext, routeKey: string): Promise<JsonRecord> {
  const current = await authorize(deps, auth, routeKey, undefined, { capabilities: true });
  return { schema_version: 'bailing.agent-knowledge-capabilities.v1', protocol: AGENT_KNOWLEDGE_PROTOCOL,
    supported: true, route: routeKey, enabled: Boolean(current.cfg && deps.kbService),
    knowledge_scope_revision: current.revision, delivery_modes: ['inline', 'on_demand'], limits: AGENT_KNOWLEDGE_LIMITS };
}

async function searchKnowledge(deps: AgentClientRuntimeDeps, auth: AgentToolAuthContext, routeKey: string, input: AgentKnowledgeSearchInput,
  preparing = false): Promise<JsonRecord> {
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.query)
    || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 3))) {
    throw new AgentToolApiError(400, 'invalid_request', 'Knowledge search requires a non-empty query up to 2000 characters and a limit from 1 to 3.');
  }
  const runId = checkRunId(input.run_id); const current = await authorize(deps, auth, routeKey, runId, { preparing });
  const base: JsonRecord = { schema_version: 'bailing.agent-knowledge-search.v1', route: routeKey,
    ...(runId ? { run_id: runId } : {}), knowledge_scope_revision: current.revision,
    status: current.cfg ? 'unavailable' : 'disabled', trust: 'reference_only', hints: [], truncated: false };
  if (!current.cfg || !deps.kbService) return base;
  // Fail closed if signing is unavailable before spending embedding work.
  signingKey(deps, 'ref');
  let result;
  try { result = await deps.kbService.searchForAgent(current.cfg.kb_ids, input.query, Math.max(current.cfg.top_k, 8), current.cfg.min_score, input.limit ?? 3); }
  catch { return base; }
  const after = await authorize(deps, auth, routeKey, runId, { preparing });
  if (after.revision !== current.revision) return scopeChanged();
  const hints: JsonRecord[] = []; const expiry = now(deps) + AGENT_KNOWLEDGE_LIMITS.reference_ttl_seconds * 1000;
  base.status = result.status; base.hints = hints; base.truncated = result.truncated;
  for (const doc of result.documents) {
    if (!after.cfg?.kb_ids.includes(doc.kb_id)) continue;
    let fresh: AgentKnowledgeDocument | null;
    try { fresh = await deps.kbService.getAgentDocumentSnapshot(doc.kb_id, doc.doc_id); }
    catch { base.status = hints.length ? 'partial' : 'unavailable'; base.truncated = true; continue; }
    if (!fresh || fresh.revision !== doc.revision) { base.truncated = true; continue; }
    const payload: ReferencePayload = { v: 1, c: after.auth.client.app_id, s: after.auth.session.session_id,
      p: principalHash(after.auth), w: routeKey, g: after.revision, k: doc.kb_id, d: doc.doc_id, r: doc.revision, e: expiry,
      ...(runId ? { u: runId } : {}) };
    const hint = { ref: sign(deps, 'ref', payload), title: prefixChars(doc.title, 100),
      summary: prefixChars(doc.summary, 200), revision: doc.revision, score: doc.score, expires_at: new Date(expiry).toISOString() };
    hints.push(hint);
    if (bytes(base) > AGENT_KNOWLEDGE_LIMITS.search_max_bytes) {
      hints.pop(); base.truncated = true; break;
    }
  }
  return base;
}

export async function searchAgentKnowledgeFor(deps: AgentClientRuntimeDeps, auth: AgentToolAuthContext, routeKey: string,
  input: AgentKnowledgeSearchInput): Promise<JsonRecord> {
  return searchKnowledge(deps, auth, routeKey, input);
}

/** Server-only turn assembly may issue run-bound hints before finalizeTurn. Not a public search mode. */
export async function prepareAgentKnowledgeFor(deps: AgentClientRuntimeDeps, auth: AgentToolAuthContext, routeKey: string,
  input: { query: string; run_id: string }): Promise<JsonRecord> {
  checkRunId(input.run_id);
  return searchKnowledge(deps, auth, routeKey, { ...input, limit: 3 }, true);
}

export async function readAgentKnowledgeFor(deps: AgentClientRuntimeDeps, auth: AgentToolAuthContext, routeKey: string, input: AgentKnowledgeReadInput): Promise<JsonRecord> {
  const max = input.max_bytes ?? AGENT_KNOWLEDGE_LIMITS.read_default_bytes;
  if (!Number.isInteger(max) || max < 4096 || max > AGENT_KNOWLEDGE_LIMITS.read_max_bytes) {
    throw new AgentToolApiError(400, 'invalid_request', 'max_bytes must be from 4096 to 32768.');
  }
  const runId = checkRunId(input.run_id); const current = await authorize(deps, auth, routeKey, runId);
  const ref = open(deps, 'ref', input.ref);
  if (ref.c !== current.auth.client.app_id || ref.s !== current.auth.session.session_id || ref.p !== principalHash(current.auth)
    || ref.w !== routeKey || ref.u !== runId || typeof ref.k !== 'string' || !Number.isSafeInteger(ref.d) || Number(ref.d) < 1 || typeof ref.r !== 'string') return invalid();
  if (ref.g !== current.revision) return scopeChanged();
  if (!current.cfg?.kb_ids.includes(ref.k)) return scopeChanged();
  if (!deps.kbService) return unavailable();
  let doc: AgentKnowledgeDocument | null;
  try { doc = await deps.kbService.getAgentDocumentSnapshot(ref.k, Number(ref.d)); } catch { return unavailable(); }
  if (!doc || doc.revision !== ref.r) return changed();
  const after = await authorize(deps, auth, routeKey, runId);
  if (after.revision !== current.revision) return scopeChanged();
  // Authorization storage itself is asynchronous. Fence content again after that await,
  // so an update/deletion/disable observed in that window cannot return the old snapshot.
  try { doc = await deps.kbService.getAgentDocumentSnapshot(ref.k, Number(ref.d)); } catch { return unavailable(); }
  if (!doc || doc.revision !== ref.r) return changed();
  const limited = prefixBytes(doc.content, AGENT_KNOWLEDGE_LIMITS.read_chain_max_bytes);
  let offset = 0;
  if (input.cursor !== undefined) {
    const cursor = open(deps, 'cursor', input.cursor);
    if (cursor.f !== hash(input.ref) || cursor.r !== doc.revision || cursor.e !== ref.e
      || !Number.isSafeInteger(cursor.o) || Number(cursor.o) < 0 || Number(cursor.o) > limited.length) return invalid();
    offset = Number(cursor.o);
    if (offset > 0 && /[\uD800-\uDBFF]/.test(limited[offset - 1]!) && /[\uDC00-\uDFFF]/.test(limited[offset] ?? '')) return invalid();
  }
  const response = (end: number): JsonRecord => ({ schema_version: 'bailing.agent-knowledge-read.v1', route: routeKey,
    ...(runId ? { run_id: runId } : {}), knowledge_scope_revision: current.revision, ref: input.ref,
    revision: doc!.revision, title: prefixChars(doc!.title, 300), content: limited.slice(offset, end), trust: 'reference_only',
    next_cursor: end < limited.length ? sign(deps, 'cursor', { v: 1, f: hash(input.ref), r: doc!.revision, o: end, e: Number(ref.e) }) : null,
    truncated: end < doc!.content.length, budget_exhausted: end === limited.length && limited.length < doc!.content.length,
    total_content_bytes: Buffer.byteLength(doc!.content, 'utf8'), read_chain_max_bytes: AGENT_KNOWLEDGE_LIMITS.read_chain_max_bytes });
  let low = offset; let high = limited.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2); const end = prefixChars(limited, middle).length;
    if (bytes(response(end)) <= max) low = middle;
    else high = middle - 1;
  }
  const end = prefixChars(limited, low).length;
  if (end <= offset && offset < limited.length) return unavailable();
  const result = response(end);
  if (bytes(result) > max) return unavailable();
  return result;
}
