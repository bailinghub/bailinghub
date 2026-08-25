import { createHash, randomUUID } from 'node:crypto';
import { agentDirectToolsConfig } from '../core/config/tools-config';
import type { ToolDefinition } from '../core/contracts/tool-definition';
import { argsHash, type ToolExecutionJournalEntry } from '../core/contracts/tools';
import type { AgentSession, Client, Job, Route } from '../core/contracts/types';
import { audienceAllows } from '../core/runtime/identity-runtime';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { clientAllowsRoute, rateLimitedFor } from './auth';
import { assembleResolvedToolRuntimeFor } from './tool-assembly';
import { resolveAllowedToolsFor, type AllowedToolContext } from './tool-context';
import type { ToolProxyDeps } from './tool-proxy';
import {
  AGENT_TOOL_JOB_MARKER,
  AGENT_TOOL_JOB_SOURCE_PREFIX,
  AGENT_TOOL_JOB_TARGET,
  isAgentToolInvocationJob,
} from './agent-tool-job';

const ROUTE_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const INVOCATION_RE = /^[a-f0-9]{64}$/;
const AGENT_RUN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_RE = /^[a-f0-9]{64}$/;
const ARGUMENTS_MAX_BYTES = 4096;
const INVOCATION_LOCK_TTL_MS = 15 * 60_000;

export const AGENT_TOOL_CATALOG_SCHEMA = 'bailing.agent-tool-catalog.v1';
export const AGENT_TOOL_INVOCATION_SCHEMA = 'bailing.agent-tool-invocation.v1';
const AGENT_TOOL_EXECUTION_FINGERPRINT_SCHEMA = 'bailing.agent-tool-execution.v1';

export type AgentToolInvocationState =
  | 'executed'
  | 'business_rejected'
  | 'awaiting_approval'
  | 'denied'
  | 'rejected_before_dispatch'
  | 'reconciliation_required'
  | 'in_progress';

export interface AgentToolAuthContext {
  session: AgentSession;
  client: Client;
}

export interface AgentToolCatalogItem {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  scope: string;
  risk: string;
  approval_required: boolean;
  readonly: boolean;
  idempotent: boolean;
}

export interface AgentToolCatalog {
  schema_version: typeof AGENT_TOOL_CATALOG_SCHEMA;
  route: string;
  capability_revision: string;
  tools: AgentToolCatalogItem[];
}

export interface AgentToolInvocationResult {
  schema_version: typeof AGENT_TOOL_INVOCATION_SCHEMA;
  invocation_id: string;
  route: string;
  tool: string;
  state: AgentToolInvocationState;
  ok: boolean;
  auto_retry_allowed: boolean;
  text: string;
  business_status?: number;
  approval_id?: number;
}

export class AgentToolApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentToolApiError';
  }
}

interface AgentToolSurface {
  route: Route;
  revision: string;
  context: AllowedToolContext;
  tools: AgentToolCatalogItem[];
}

export interface InvokeAgentToolInput {
  invocation_id: string;
  route: string;
  capability_revision: string;
  agent_run_id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ResumeAgentToolInput {
  invocation_id: string;
}

interface FrozenInvocationCoordinates extends ResumeAgentToolInput {
  route: string;
  capability_revision: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sessionAllowsRoute(session: AgentSession, route: string): boolean {
  return session.allowed_routes.includes('*') || session.allowed_routes.includes(route);
}

function invocationRequestId(sessionId: string, invocationId: string): string {
  return `agent-tool:${sha256(`bailing.agent-tool.v1\0${sessionId}\0${invocationId}`)}`;
}

function safeText(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, maximum);
}

function safeDescription(value: string): string {
  return safeText(value, 1200);
}

const SAFE_SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'items', 'description', 'enum', 'const', 'oneOf', 'anyOf', 'allOf',
  'nullable', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'minItems', 'maxItems', 'additionalProperties',
]);

function safeInputSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (!isRecord(value) || depth > 16) return { type: 'object', properties: {} };
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SAFE_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && isRecord(raw)) {
      out[key] = Object.fromEntries(Object.entries(raw).map(([name, schema]) => [name, safeInputSchema(schema, depth + 1)]));
    } else if (key === 'items' && isRecord(raw)) {
      out[key] = safeInputSchema(raw, depth + 1);
    } else if ((key === 'oneOf' || key === 'anyOf' || key === 'allOf') && Array.isArray(raw)) {
      out[key] = raw.slice(0, 20).map((schema) => safeInputSchema(schema, depth + 1));
    } else if (key === 'additionalProperties' && isRecord(raw)) {
      out[key] = safeInputSchema(raw, depth + 1);
    } else if (key === 'description' && typeof raw === 'string') {
      out[key] = safeDescription(raw);
    } else {
      out[key] = raw;
    }
  }
  if (depth === 0) {
    out['type'] = 'object';
    if (!isRecord(out['properties'])) out['properties'] = {};
  }
  return out;
}

function directPermissionAllows(route: Route, tool: ToolDefinition, writeNames: Set<string>): boolean {
  if (tool.readonly) return true;
  if (route.permission !== 'readwrite' && route.permission !== 'full') return false;
  return writeNames.has(tool.name);
}

function directToolDefinition(tool: ToolDefinition, unattended: Set<string>): ToolDefinition {
  if (tool.readonly || unattended.has(tool.name)) return tool;
  return { ...tool, confirmRequired: true };
}

function publicTool(tool: ToolDefinition): AgentToolCatalogItem {
  return {
    name: tool.name,
    description: safeDescription(tool.description),
    input_schema: safeInputSchema(tool.inputSchema),
    scope: tool.scope,
    risk: tool.risk,
    approval_required: tool.risk === 'high' || tool.confirmRequired || !!tool.confirmWhen?.length,
    readonly: tool.readonly,
    idempotent: tool.idempotent,
  };
}

function fingerprint(route: Route, context: AllowedToolContext): string {
  return sha256(stableJson({
    schema: AGENT_TOOL_CATALOG_SCHEMA,
    route: route.route_key,
    permission: route.permission ?? null,
    audience: route.audience ?? null,
    direct: agentDirectToolsConfig(route.tools),
    sources: context.sources.map((source) => ({
      provider: source.provider.name,
      provider_enabled: source.provider.enabled,
      provider_base: sha256(source.provider.base_url),
      provider_spec: sha256(source.provider.spec_json ?? ''),
      allow: source.sourceCfg.allow,
      tools: source.allowed.map((tool) => ({
        name: tool.name,
        method: tool.method,
        path: tool.path,
        scope: tool.scope,
        risk: tool.risk,
        confirm_required: tool.confirmRequired,
        confirm_when: tool.confirmWhen ?? [],
        requires_subject: tool.requiresSubject,
        readonly: tool.readonly,
        idempotent: tool.idempotent,
        input_schema: tool.inputSchema,
        param_in: tool.paramIn,
      })),
    })),
  }));
}

/**
 * 只冻结当前这一个工具的出站与治理语义。其他工具或文案变更会使
 * catalog revision 漂移，但不应阻断这次 invocation 的结果回放/审批续执行。
 * Provider secret 也不入指纹，允许安全轮换；实际业务目标 base URL 必须冻结。
 */
function executionFingerprint(surface: AgentToolSurface, toolName: string): string | null {
  const owners = surface.context.sources.flatMap((source) => source.allowed
    .filter((tool) => tool.name === toolName)
    .map((tool) => ({ source, tool })));
  if (owners.length !== 1) return null;
  const { source, tool } = owners[0]!;
  return sha256(stableJson({
    schema: AGENT_TOOL_EXECUTION_FINGERPRINT_SCHEMA,
    route: surface.route.route_key,
    provider: {
      name: source.provider.name,
      base: sha256(source.provider.base_url),
    },
    tool: {
      name: tool.name,
      method: tool.method,
      path: tool.path,
      scope: tool.scope,
      risk: tool.risk,
      confirm_required: tool.confirmRequired,
      confirm_when: tool.confirmWhen ?? [],
      requires_subject: tool.requiresSubject,
      sensitive: tool.sensitive,
      readonly: tool.readonly,
      idempotent: tool.idempotent,
      input_schema: tool.inputSchema,
      param_in: tool.paramIn,
    },
  }));
}

function probeJob(auth: AgentToolAuthContext, route: Route, now: string): Job {
  return {
    job_id: '00000000-0000-4000-8000-000000000000',
    request_id: 'agent-tool-catalog',
    status: 'done',
    target: AGENT_TOOL_JOB_TARGET,
    profile: route.profile,
    project: route.project ?? '',
    source: `${AGENT_TOOL_JOB_SOURCE_PREFIX}${auth.client.app_id}`,
    client_app_id: auth.client.app_id,
    agent_session_id: auth.session.session_id,
    on_behalf_of: auth.session.on_behalf_of,
    session_id: auth.session.session_id,
    input_preview: '',
    metadata: { agent_tool_call_v1: true },
    dispatch: { route_key: route.route_key, route_name: route.name, tools: route.tools },
    created_at: now,
    updated_at: now,
  };
}

async function resolveDirectRoute(deps: ToolProxyDeps, auth: AgentToolAuthContext, routeKey: string): Promise<Route> {
  if (!deps.configStore) throw new AgentToolApiError(503, 'agent_tools_unavailable', 'Agent tools require the MySQL control plane.');
  if (!ROUTE_RE.test(routeKey) || routeKey === 'auto') throw new AgentToolApiError(400, 'invalid_route', 'The configured route is invalid.');
  if (!clientAllowsRoute(auth.client, routeKey) || !sessionAllowsRoute(auth.session, routeKey)) {
    throw new AgentToolApiError(403, 'route_not_allowed', 'The Agent Session is not allowed to use this route.');
  }
  const route = await deps.configStore.routes.get(routeKey);
  if (!route?.enabled) throw new AgentToolApiError(404, 'route_unavailable', 'The configured route is unavailable.');
  const direct = agentDirectToolsConfig(route.tools);
  if (!direct) throw new AgentToolApiError(403, 'agent_direct_disabled', 'Direct Agent tools are not enabled for this route.');
  const principal = {
    ...auth.session.principal,
    roles: [...auth.session.principal.roles],
    client_app_id: auth.client.app_id,
    channel: auth.session.principal.channel ?? `agent:${auth.client.app_id}`,
  };
  const audience = audienceAllows(route.audience, principal);
  if (!audience.ok) throw new AgentToolApiError(403, 'audience_not_allowed', 'The business identity is not allowed to use this route.');
  return route;
}

async function resolveSurface(deps: ToolProxyDeps, auth: AgentToolAuthContext, routeKey: string): Promise<AgentToolSurface> {
  const route = await resolveDirectRoute(deps, auth, routeKey);
  const direct = agentDirectToolsConfig(route.tools)!;
  const resolved = await resolveAllowedToolsFor(deps.configStore, probeJob(auth, route, deps.now()), route);
  if (!resolved) {
    const empty: AllowedToolContext = { sources: [], allowed: [], toolsCfg: route.tools ?? {}, lockedBySubject: 0 };
    return { route, revision: fingerprint(route, empty), context: empty, tools: [] };
  }
  const writeNames = new Set(direct.write_tools ?? []);
  const unattended = new Set(direct.unattended_write_tools ?? []);
  const sources = resolved.sources.map((source) => ({
    ...source,
    allowed: source.allowed
      .filter((tool) => directPermissionAllows(route, tool, writeNames))
      .map((tool) => directToolDefinition(tool, unattended)),
  })).filter((source) => source.allowed.length);
  const allowed = sources.flatMap((source) => source.allowed).sort((a, b) => a.name.localeCompare(b.name));
  const context: AllowedToolContext = { ...resolved, sources, allowed };
  return { route, revision: fingerprint(route, context), context, tools: allowed.map(publicTool) };
}

export async function listAgentToolsFor(deps: ToolProxyDeps, auth: AgentToolAuthContext, route: string): Promise<AgentToolCatalog> {
  const surface = await resolveSurface(deps, auth, route);
  return {
    schema_version: AGENT_TOOL_CATALOG_SCHEMA,
    route: surface.route.route_key,
    capability_revision: surface.revision,
    tools: surface.tools,
  };
}

function parseInvocationResult(job: Job): AgentToolInvocationResult | null {
  const value = job.result;
  if (!isRecord(value) || value['schema_version'] !== AGENT_TOOL_INVOCATION_SCHEMA) return null;
  const state = String(value['state'] ?? '') as AgentToolInvocationState;
  const states: AgentToolInvocationState[] = ['executed', 'business_rejected', 'awaiting_approval', 'denied', 'rejected_before_dispatch', 'reconciliation_required', 'in_progress'];
  const metadata = job.metadata ?? {};
  if (!states.includes(state)
      || value['invocation_id'] !== metadata['agent_invocation_id']
      || value['route'] !== metadata['agent_route']
      || value['tool'] !== metadata['agent_tool']
      || typeof value['ok'] !== 'boolean'
      || typeof value['auto_retry_allowed'] !== 'boolean'
      || typeof value['text'] !== 'string'
      || value['text'].length > 8192
      || (value['business_status'] !== undefined && (!Number.isInteger(value['business_status']) || Number(value['business_status']) < 1))
      || (value['approval_id'] !== undefined && (!Number.isInteger(value['approval_id']) || Number(value['approval_id']) < 1))) return null;
  return value as unknown as AgentToolInvocationResult;
}

function publicResult(input: {
  invocationId: string;
  route: string;
  tool: string;
  state: AgentToolInvocationState;
  ok: boolean;
  text: string;
  autoRetryAllowed?: boolean;
  businessStatus?: number;
  approvalId?: number;
}): AgentToolInvocationResult {
  return {
    schema_version: AGENT_TOOL_INVOCATION_SCHEMA,
    invocation_id: input.invocationId,
    route: input.route,
    tool: input.tool,
    state: input.state,
    ok: input.ok,
    auto_retry_allowed: input.autoRetryAllowed ?? false,
    text: safeText(input.text, 8192),
    ...(input.businessStatus !== undefined ? { business_status: input.businessStatus } : {}),
    ...(input.approvalId !== undefined ? { approval_id: input.approvalId } : {}),
  };
}

function isStableInvocationResult(result: AgentToolInvocationResult | null): result is AgentToolInvocationResult {
  return !!result
    && !['in_progress', 'awaiting_approval'].includes(result.state)
    && result.auto_retry_allowed !== true;
}

function assertCurrentToolAuthorized(surface: AgentToolSurface, tool: string): void {
  if (!surface.context.allowed.some((candidate) => candidate.name === tool)) {
    throw new AgentToolApiError(409, 'capability_changed', 'The tool is no longer authorized for this Agent Session and route.');
  }
}

function assertCurrentToolExecution(job: Job, surface: AgentToolSurface, tool: string): void {
  assertCurrentToolAuthorized(surface, tool);
  const frozen = String(job.metadata?.['agent_execution_fingerprint'] ?? '');
  const current = executionFingerprint(surface, tool);
  if (!current || current !== frozen) {
    throw new AgentToolApiError(409, 'capability_changed', 'The selected tool execution contract changed; start a new invocation from the refreshed catalog.');
  }
}

function assertInvocationInput(input: InvokeAgentToolInput): void {
  if (!INVOCATION_RE.test(input.invocation_id) || !ROUTE_RE.test(input.route) || !REVISION_RE.test(input.capability_revision) ||
      !AGENT_RUN_RE.test(input.agent_run_id) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(input.tool) || !isRecord(input.arguments)) {
    throw new AgentToolApiError(400, 'invalid_request', 'The Agent tool invocation request is invalid.');
  }
  const encoded = JSON.stringify(input.arguments);
  if (Buffer.byteLength(encoded, 'utf8') > ARGUMENTS_MAX_BYTES) {
    throw new AgentToolApiError(413, 'arguments_too_large', `Tool arguments exceed ${ARGUMENTS_MAX_BYTES} bytes.`);
  }
}

function assertResumeInput(input: ResumeAgentToolInput): void {
  if (!INVOCATION_RE.test(input.invocation_id)) {
    throw new AgentToolApiError(400, 'invalid_request', 'The Agent tool resume request is invalid.');
  }
}

function sameInvocation(job: Job, auth: AgentToolAuthContext, input: {
  invocation_id: string;
  route: string;
  tool?: string;
  args_hash?: string;
  capability_revision: string;
  agent_run_id?: string;
}): boolean {
  const meta = job.metadata ?? {};
  return isAgentToolInvocationJob(job) &&
    job.agent_session_id === auth.session.session_id &&
    job.client_app_id === auth.client.app_id &&
    meta['agent_invocation_id'] === input.invocation_id &&
    meta['agent_route'] === input.route &&
    meta['agent_capability_revision'] === input.capability_revision &&
    (input.agent_run_id === undefined || meta['agent_run_id'] === input.agent_run_id) &&
    (input.tool === undefined || meta['agent_tool'] === input.tool) &&
    (input.args_hash === undefined || meta['agent_args_hash'] === input.args_hash);
}

function syntheticJob(
  auth: AgentToolAuthContext,
  surface: AgentToolSurface,
  input: InvokeAgentToolInput,
  hash: string,
  toolFingerprint: string,
  now: string,
): Job {
  const initial = publicResult({
    invocationId: input.invocation_id,
    route: input.route,
    tool: input.tool,
    state: 'in_progress',
    ok: false,
    text: 'The governed tool invocation is in progress.',
  });
  return {
    job_id: randomUUID(),
    request_id: invocationRequestId(auth.session.session_id, input.invocation_id),
    status: 'done',
    target: AGENT_TOOL_JOB_TARGET,
    profile: surface.route.profile,
    project: surface.route.project ?? '',
    source: `${AGENT_TOOL_JOB_SOURCE_PREFIX}${auth.client.app_id}`,
    client_app_id: auth.client.app_id,
    agent_session_id: auth.session.session_id,
    on_behalf_of: auth.session.on_behalf_of,
    session_id: input.agent_run_id,
    input_preview: `Agent tool ${input.tool}`.slice(0, 200),
    result: { ...initial },
    metadata: {
      agent_tool_job_marker: AGENT_TOOL_JOB_MARKER,
      agent_tool_call_v1: true,
      agent_invocation_id: input.invocation_id,
      agent_run_id: input.agent_run_id,
      agent_route: input.route,
      agent_tool: input.tool,
      agent_args_hash: hash,
      agent_capability_revision: input.capability_revision,
      agent_execution_fingerprint: toolFingerprint,
      principal: { ...auth.session.principal },
    },
    dispatch: { route_key: surface.route.route_key, route_name: surface.route.name, tools: surface.route.tools },
    created_at: now,
    updated_at: now,
  };
}

async function currentApproval(config: ConfigStoreContract, job: Job, tool: string, hash: string) {
  const rows = await config.approvals.forJob(job.job_id);
  return [...rows].reverse().find((row) => row.tool === tool && row.args_hash === hash) ?? null;
}

function fromJournal(input: FrozenInvocationCoordinates, tool: string, entry: ToolExecutionJournalEntry): AgentToolInvocationResult {
  if (entry.state !== 'completed') {
    return publicResult({
      invocationId: input.invocation_id,
      route: input.route,
      tool,
      state: 'reconciliation_required',
      ok: false,
      text: `The tool execution is unresolved (${entry.state}). Use idempotency key ${entry.idempotencyKey} for manual reconciliation; do not replay it.`,
    });
  }
  return publicResult({
    invocationId: input.invocation_id,
    route: input.route,
    tool,
    state: entry.ok ? 'executed' : 'business_rejected',
    ok: entry.ok,
    text: entry.text,
    businessStatus: entry.status,
  });
}

async function persistResult(deps: ToolProxyDeps, job: Job, result: AgentToolInvocationResult): Promise<void> {
  await deps.stateStore.updateJob(job.job_id, { status: 'done', result: { ...result }, error: undefined });
  await deps.stateStore.appendAudit({
    ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event: 'agent_tool_invocation_state',
    detail: { invocation_id: result.invocation_id, route: result.route, tool: result.tool, state: result.state, ok: result.ok, business_status: result.business_status ?? null },
  }).catch(() => undefined);
}

async function invokeExisting(
  deps: ToolProxyDeps,
  auth: AgentToolAuthContext,
  surface: AgentToolSurface,
  job: Job,
  input: FrozenInvocationCoordinates,
  tool: string,
  hash: string,
  args: Record<string, unknown> | null,
): Promise<AgentToolInvocationResult> {
  const cached = parseInvocationResult(job);
  if (isStableInvocationResult(cached)) return cached;
  if (!surface.context.allowed.some((candidate) => candidate.name === tool)) {
    throw new AgentToolApiError(409, 'capability_changed', 'The tool is no longer available; refresh the capability catalog.');
  }
  const journal = await deps.configStore!.toolCalls.get(job.job_id, tool, hash).catch(() => null);
  if (journal) {
    const result = fromJournal(input, tool, journal);
    await persistResult(deps, job, result);
    return result;
  }
  const approval = await currentApproval(deps.configStore!, job, tool, hash);
  if (approval?.status === 'denied') {
    const result = publicResult({ invocationId: input.invocation_id, route: input.route, tool, state: 'denied', ok: false, text: 'The governed tool invocation was denied.' });
    await persistResult(deps, job, result);
    return result;
  }
  if (approval?.status === 'pending') {
    const result = publicResult({ invocationId: input.invocation_id, route: input.route, tool, state: 'awaiting_approval', ok: false, text: 'The governed tool invocation is awaiting approval.', approvalId: approval.id });
    await persistResult(deps, job, result);
    return result;
  }
  if (!args && approval?.status === 'approved' && approval.args_json) {
    try {
      const parsed: unknown = JSON.parse(approval.args_json);
      if (isRecord(parsed) && argsHash(parsed) === hash) args = parsed;
    } catch { /* 损坏的审批快照不执行 */ }
  }
  if (!args) {
    const result = publicResult({ invocationId: input.invocation_id, route: input.route, tool, state: 'rejected_before_dispatch', ok: false, text: 'The exact frozen arguments are unavailable; the invocation was not dispatched.' });
    await persistResult(deps, job, result);
    return result;
  }

  const runtime = await assembleResolvedToolRuntimeFor(
    deps.configStore, deps.stateStore, deps.toolIndex, job, surface.context,
    deps.cfg, deps.now, deps.sleep, deps.targetRegistry,
  );
  if (!runtime || runtime === 'subject_locked') {
    throw new AgentToolApiError(409, 'capability_changed', 'The tool surface is no longer available; refresh the capability catalog.');
  }
  const out = await runtime.invoke(tool, args);
  const uncertainty = runtime.executionUncertainty();
  const state: AgentToolInvocationState = uncertainty || out.governance_state === 'reconciliation_required'
    ? 'reconciliation_required'
    : out.governance_state === 'awaiting_approval'
      ? 'awaiting_approval'
      : out.governance_state === 'rejected_before_dispatch'
        ? 'rejected_before_dispatch'
      : out.status > 0
        ? (out.ok ? 'executed' : 'business_rejected')
        : 'rejected_before_dispatch';
  const result = publicResult({
    invocationId: input.invocation_id,
    route: input.route,
    tool,
    state,
    ok: out.ok,
    text: out.text,
    autoRetryAllowed: out.auto_retry_allowed ?? false,
    ...(out.status > 0 && out.governance_state !== 'rejected_before_dispatch' ? { businessStatus: out.status } : {}),
    ...(out.approval_id !== undefined ? { approvalId: out.approval_id } : {}),
  });
  await persistResult(deps, job, result);
  return result;
}

export async function invokeAgentToolFor(deps: ToolProxyDeps, auth: AgentToolAuthContext, input: InvokeAgentToolInput): Promise<AgentToolInvocationResult> {
  assertInvocationInput(input);
  const hash = argsHash(input.arguments);
  const requestId = invocationRequestId(auth.session.session_id, input.invocation_id);
  const lockKey = `agent-tool:${requestId}`;
  const owner = randomUUID();
  if (!await deps.stateStore.acquireRuntimeLock(lockKey, owner, INVOCATION_LOCK_TTL_MS)) {
    return publicResult({ invocationId: input.invocation_id, route: input.route, tool: input.tool, state: 'in_progress', ok: false, text: 'The same governed invocation is already in progress.', autoRetryAllowed: true });
  }
  try {
    let job = await deps.stateStore.findByRequestId(requestId);
    if (job && !sameInvocation(job, auth, { ...input, args_hash: hash })) {
      throw new AgentToolApiError(409, 'invocation_conflict', 'The invocation_id is already bound to a different call.');
    }
    if (job) await resolveDirectRoute(deps, auth, input.route);
    const cached = job ? parseInvocationResult(job) : null;
    let surface: AgentToolSurface | null = null;
    if (isStableInvocationResult(cached)) {
      surface = await resolveSurface(deps, auth, input.route);
      assertCurrentToolAuthorized(surface, input.tool);
      return cached;
    }
    surface = await resolveSurface(deps, auth, input.route);
    if (!job) {
      if (await rateLimitedFor(deps.configStore, auth.client)) {
        return publicResult({ invocationId: input.invocation_id, route: input.route, tool: input.tool, state: 'rejected_before_dispatch', ok: false, text: 'The Agent client rate limit was exceeded.', autoRetryAllowed: true });
      }
      if (surface.revision !== input.capability_revision) {
        throw new AgentToolApiError(409, 'capability_changed', 'The capability catalog changed; refresh tools before calling.');
      }
      const definition = surface.context.allowed.find((tool) => tool.name === input.tool);
      const toolFingerprint = executionFingerprint(surface, input.tool);
      if (!definition || !toolFingerprint) {
        throw new AgentToolApiError(404, 'tool_not_found', 'The tool is not available in the current capability catalog.');
      }
      job = syntheticJob(auth, surface, input, hash, toolFingerprint, deps.now());
      await deps.stateStore.createJob(job);
      await deps.stateStore.appendAudit({
        ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event: 'agent_tool_invocation_created',
        detail: { invocation_id: input.invocation_id, agent_run_id: input.agent_run_id, route: input.route, tool: input.tool, args_hash: hash, execution_fingerprint: toolFingerprint, client_app_id: auth.client.app_id, agent_session_id: auth.session.session_id },
      });
    } else {
      assertCurrentToolExecution(job, surface, input.tool);
      if (await rateLimitedFor(deps.configStore, auth.client)) {
        return publicResult({ invocationId: input.invocation_id, route: input.route, tool: input.tool, state: 'rejected_before_dispatch', ok: false, text: 'The Agent client rate limit was exceeded.', autoRetryAllowed: true });
      }
    }
    return await invokeExisting(deps, auth, surface, job, input, input.tool, hash, input.arguments);
  } finally {
    await deps.stateStore.releaseRuntimeLock(lockKey, owner).catch(() => undefined);
  }
}

export async function resumeAgentToolFor(deps: ToolProxyDeps, auth: AgentToolAuthContext, input: ResumeAgentToolInput): Promise<AgentToolInvocationResult> {
  assertResumeInput(input);
  const requestId = invocationRequestId(auth.session.session_id, input.invocation_id);
  const lockKey = `agent-tool:${requestId}`;
  const owner = randomUUID();
  if (!await deps.stateStore.acquireRuntimeLock(lockKey, owner, INVOCATION_LOCK_TTL_MS)) {
    const current = await deps.stateStore.findByRequestId(requestId);
    const route = String(current?.metadata?.['agent_route'] ?? 'unknown');
    const tool = String(current?.metadata?.['agent_tool'] ?? 'unknown');
    return publicResult({ invocationId: input.invocation_id, route, tool, state: 'in_progress', ok: false, text: 'The governed invocation is already in progress.', autoRetryAllowed: true });
  }
  try {
    const job = await deps.stateStore.findByRequestId(requestId);
    if (!job || !isAgentToolInvocationJob(job) || job.agent_session_id !== auth.session.session_id || job.client_app_id !== auth.client.app_id) {
      throw new AgentToolApiError(404, 'invocation_not_found', 'The governed invocation was not found.');
    }
    const route = String(job.metadata['agent_route'] ?? '');
    const capabilityRevision = String(job.metadata['agent_capability_revision'] ?? '');
    const tool = String(job.metadata['agent_tool'] ?? '');
    const hash = String(job.metadata['agent_args_hash'] ?? '');
    const frozen: FrozenInvocationCoordinates = {
      invocation_id: input.invocation_id,
      route,
      capability_revision: capabilityRevision,
    };
    if (!sameInvocation(job, auth, { ...frozen, tool, args_hash: hash })) {
      throw new AgentToolApiError(409, 'invocation_conflict', 'The invocation no longer matches this Agent Session and catalog.');
    }
    await resolveDirectRoute(deps, auth, route);
    const cached = parseInvocationResult(job);
    const surface = await resolveSurface(deps, auth, route);
    if (isStableInvocationResult(cached)) {
      assertCurrentToolAuthorized(surface, tool);
      return cached;
    }
    assertCurrentToolExecution(job, surface, tool);
    if (await rateLimitedFor(deps.configStore, auth.client)) {
      return publicResult({ invocationId: input.invocation_id, route, tool, state: 'rejected_before_dispatch', ok: false, text: 'The Agent client rate limit was exceeded.', autoRetryAllowed: true });
    }
    return await invokeExisting(deps, auth, surface, job, frozen, tool, hash, null);
  } finally {
    await deps.stateStore.releaseRuntimeLock(lockKey, owner).catch(() => undefined);
  }
}
