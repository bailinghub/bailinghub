import { createHash } from 'node:crypto';
import { AgentToolApiError, listAgentToolsFor, searchAgentToolsFor, type AgentToolAuthContext, type AgentToolCatalog } from './agent-tool-invocations';
import type { ToolProxyDeps } from './tool-proxy';
import { routeAgentClientConfig, routeKnowledgeConfig } from '../core/config/route-config';
import { resolveMemoryConfig } from '../core/runtime/memory';
import { maxToolCalls } from '../core/config/tools-config';
import type { Route } from '../core/contracts/types';
import type { KbService } from '../services/kb';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import { AgentClientRuntimeConflictError, type AgentClientRunRecord } from '../infrastructure/config/config-agent-client-runtime-repository';

export const AGENT_RUNTIME_PROFILE_SCHEMA = 'bailing.agent-runtime-profile.v1';
export const AGENT_TURN_CONTEXT_SCHEMA = 'bailing.agent-turn-context.v1';
export const AGENT_WORKSPACES_SCHEMA = 'bailing.agent-workspaces.v1';
export const AGENT_RUN_COMPLETION_SCHEMA = 'bailing.agent-run-completion.v1';

export interface AgentClientRuntimeDeps {
  toolProxyDeps: ToolProxyDeps;
  kbService: KbService | null;
  stateStore: RuntimeStateStore;
}

export interface AgentTurnInput {
  client_conversation_id: string;
  client_turn_id: string;
  user_message_id: string;
  user_input: string;
  page_context?: Record<string, unknown>;
  renderers?: string[];
}

export interface AgentRunCompleteInput {
  assistant_message_id: string;
  status: 'completed' | 'failed' | 'cancelled';
  content: string;
  model?: string;
  runtime?: string;
  usage?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function safeText(value: unknown, maximum: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, maximum)
    : '';
}

const DISALLOWED_CLIENT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Client-owned DTO text is never rewritten: invalid input fails closed instead. */
function strictClientText(value: string, name: string, maximum: number, requireContent = false): string {
  if (value.length > maximum) {
    throw new AgentToolApiError(400, 'invalid_request', `${name} must not exceed ${maximum} characters.`);
  }
  if (DISALLOWED_CLIENT_CONTROL_RE.test(value)) {
    throw new AgentToolApiError(400, 'invalid_request', `${name} contains disallowed control characters.`);
  }
  if (requireContent && !value.trim()) {
    throw new AgentToolApiError(400, 'invalid_request', `${name} must not be empty.`);
  }
  return value;
}

function strictRenderers(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.length > 20) {
    throw new AgentToolApiError(400, 'invalid_request', 'renderers must not contain more than 20 entries.');
  }
  const seen = new Set<string>();
  for (const renderer of value) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(renderer)) {
      throw new AgentToolApiError(400, 'invalid_request', 'renderers contains an invalid renderer name.');
    }
    if (seen.has(renderer)) {
      throw new AgentToolApiError(400, 'invalid_request', 'renderers must not contain duplicate names.');
    }
    seen.add(renderer);
  }
  return [...value];
}

function safeId(value: string, name: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) {
    throw new AgentToolApiError(400, 'invalid_request', `${name} must be a 1..128 character stable identifier.`);
  }
  return id;
}

function safeRunId(value: string): string {
  const id = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new AgentToolApiError(400, 'invalid_request', 'run_id must be a UUID.');
  }
  return id;
}

function publicInstructions(route: Route): string {
  const system = safeText(route.target_config?.['system_prompt'], 40_000);
  const client = safeText(routeAgentClientConfig(route)?.instructions, 20_000);
  return [system ? `【路由系统规则】\n${system}` : '', client ? `【本地 Agent 补充规则】\n${client}` : ''].filter(Boolean).join('\n\n');
}

async function authorizedRuntime(
  deps: AgentClientRuntimeDeps,
  auth: AgentToolAuthContext,
  routeKey: string,
): Promise<{ route: Route; catalog: AgentToolCatalog; activeLimit: number }> {
  const route = await deps.toolProxyDeps.configStore?.routes.get(routeKey);
  if (!route) throw new AgentToolApiError(404, 'route_unavailable', 'The configured route is unavailable.');
  const client = routeAgentClientConfig(route);
  if (!client) throw new AgentToolApiError(403, 'agent_client_disabled', 'Agent Client Runtime is not enabled for this route.');
  const catalog = await listAgentToolsFor(deps.toolProxyDeps, auth, routeKey);
  return { route, catalog, activeLimit: client.active_tool_limit };
}

function profileFor(route: Route, catalog: AgentToolCatalog, activeLimit: number): Record<string, unknown> {
  const memory = resolveMemoryConfig(route.memory);
  const knowledge = routeKnowledgeConfig(route.knowledge);
  const workspace = { route: route.route_key, name: safeText(route.name, 128), description: safeText(route.description, 1000) };
  const governance = {
    planner: 'local_agent', execution: 'bailinghub_governed', authorization: 'server_revalidated',
    knowledge_trust: 'reference_only', tool_results_trust: 'untrusted_data', hidden_reasoning_sync: false,
    max_tool_calls: maxToolCalls(route.tools), permission: safeText(route.permission, 64) || null,
  };
  const profileBody = {
    instructions: publicInstructions(route),
    knowledge: knowledge ? {
      enabled: true, sources: knowledge.kb_ids.length, mode: knowledge.inject,
      top_k: knowledge.top_k, max_docs: knowledge.max_docs, page_boost: knowledge.page_boost,
    } : { enabled: false, sources: 0 },
    memory: {
      recent_messages: memory.recent_messages, recent_budget_chars: memory.recent_budget_chars,
      per_message_chars: memory.per_message_chars, summary_enabled: memory.summary_enabled,
      summary_max_chars: memory.summary_max_chars,
    },
    governance,
  };
  const revision = hash({ schema: AGENT_RUNTIME_PROFILE_SCHEMA, workspace, profile: profileBody });
  return {
    schema_version: AGENT_RUNTIME_PROFILE_SCHEMA,
    workspace,
    profile: { revision, ...profileBody },
    capabilities: {
      revision: catalog.capability_revision, authorized_total: catalog.tools.length, active_limit: activeLimit,
      readonly: catalog.tools.filter((tool) => tool.readonly).length,
      writes: catalog.tools.filter((tool) => !tool.readonly).length,
      approval_required: catalog.tools.filter((tool) => tool.approval_required).length,
    },
  };
}

export async function listAgentWorkspacesFor(deps: AgentClientRuntimeDeps, auth: AgentToolAuthContext): Promise<Record<string, unknown>> {
  const routes = await deps.toolProxyDeps.configStore?.routes.list() ?? [];
  const workspaces: Record<string, unknown>[] = [];
  for (const route of routes) {
    const client = routeAgentClientConfig(route);
    if (!client) continue;
    try {
      const catalog = await listAgentToolsFor(deps.toolProxyDeps, auth, route.route_key);
      const profile = profileFor(route, catalog, client.active_tool_limit);
      workspaces.push({
        route: route.route_key,
        name: safeText(route.name, 128),
        description: safeText(route.description, 1000),
        profile: safeText(route.profile, 64),
        permission: safeText(route.permission, 64) || null,
        profile_revision: (profile['profile'] as Record<string, unknown>)['revision'],
        capability_revision: catalog.capability_revision,
        authorized_tool_count: catalog.tools.length,
        active_tool_limit: client.active_tool_limit,
      });
    } catch (error) {
      if (!(error instanceof AgentToolApiError)) throw error;
    }
  }
  return { schema_version: AGENT_WORKSPACES_SCHEMA, workspaces };
}

export async function getAgentWorkspaceBootstrapFor(
  deps: AgentClientRuntimeDeps,
  auth: AgentToolAuthContext,
  routeKey: string,
): Promise<Record<string, unknown>> {
  const { route, catalog, activeLimit } = await authorizedRuntime(deps, auth, routeKey);
  return profileFor(route, catalog, activeLimit);
}

function trimRecent(
  rows: Array<{ direction: string; channel: string; content: string; created_at: string }>,
  cfg: ReturnType<typeof resolveMemoryConfig>,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  let budget = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const content = safeText(row.content, cfg.per_message_chars);
    if (budget + content.length > cfg.recent_budget_chars) break;
    result.unshift({ role: row.direction === 'in' ? 'user' : 'assistant', content, created_at: row.created_at });
    budget += content.length;
  }
  return result;
}

async function knowledgeFor(deps: AgentClientRuntimeDeps, route: Route, query: string): Promise<{
  items: Array<Record<string, unknown>>;
  refs: Array<Record<string, unknown>>;
}> {
  const cfg = routeKnowledgeConfig(route.knowledge);
  if (!cfg || !deps.kbService) return { items: [], refs: [] };
  try {
    if (cfg.inject === 'doc') {
      const docs = await deps.kbService.searchDocsMulti(cfg.kb_ids, query.slice(0, 2000), Math.max(cfg.top_k, 8), cfg.min_score, cfg.max_docs);
      return {
        items: docs.map((doc, index) => ({ ref: `knowledge:${index + 1}`, title: safeText(doc.title, 300), content: safeText(doc.content, 6000) })),
        refs: docs.map((doc, index) => ({ ref: `knowledge:${index + 1}`, doc_id: doc.doc_id, title: safeText(doc.title, 300), score: doc.score })),
      };
    }
    const hits = await deps.kbService.searchMulti(cfg.kb_ids, query.slice(0, 2000), cfg.top_k, cfg.min_score);
    return {
      items: hits.map((hit, index) => ({ ref: `knowledge:${index + 1}`, title: safeText(hit.title, 300), content: safeText(hit.content, 3000) })),
      refs: hits.map((hit, index) => ({ ref: `knowledge:${index + 1}`, doc_id: hit.doc_id, title: safeText(hit.title, 300), score: hit.score })),
    };
  } catch { return { items: [], refs: [] }; }
}

function queryWithPage(input: AgentTurnInput): string {
  const page = input.page_context ?? {};
  const hint = ['title', 'page_name', 'page_key', 'url'].map((key) => safeText(page[key], 500)).filter(Boolean).join(' ');
  return hint ? `${hint}\n${input.user_input}` : input.user_input;
}

export async function prepareAgentTurnFor(
  deps: AgentClientRuntimeDeps,
  auth: AgentToolAuthContext,
  routeKey: string,
  raw: AgentTurnInput,
): Promise<Record<string, unknown>> {
  const renderers = strictRenderers(raw.renderers);
  const input: AgentTurnInput = {
    client_conversation_id: safeId(raw.client_conversation_id, 'client_conversation_id'),
    client_turn_id: safeId(raw.client_turn_id, 'client_turn_id'),
    user_message_id: safeId(raw.user_message_id, 'user_message_id'),
    user_input: strictClientText(raw.user_input, 'user_input', 64_000, true),
    ...(raw.page_context ? { page_context: raw.page_context } : {}),
    ...(renderers !== undefined ? { renderers } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(input.page_context ?? {}), 'utf8') > 16 * 1024) {
    throw new AgentToolApiError(413, 'page_context_too_large', 'page_context exceeds 16 KiB.');
  }
  const repo = deps.toolProxyDeps.configStore?.agentClientRuntime;
  if (!repo) throw new AgentToolApiError(503, 'agent_runtime_unavailable', 'Agent Client Runtime requires the MySQL control plane.');
  const { route, catalog, activeLimit } = await authorizedRuntime(deps, auth, routeKey);
  const threadId = await repo.resolveConversation({
    session_id: auth.session.session_id, client_app_id: auth.client.app_id, route_key: route.route_key,
    client_conversation_id: input.client_conversation_id, principal_id: safeText(auth.session.principal.id, 64),
  });
  const requestHash = hash({ schema: AGENT_TURN_CONTEXT_SCHEMA, route: route.route_key, ...input });
  let reserved;
  try {
    reserved = await repo.reserveRun({
      session_id: auth.session.session_id, client_app_id: auth.client.app_id, route_key: route.route_key, thread_id: threadId,
      client_conversation_id: input.client_conversation_id, client_turn_id: input.client_turn_id,
      user_message_id: input.user_message_id, request_hash: requestHash, user_input: input.user_input,
    });
  } catch (error) {
    if (error instanceof AgentClientRuntimeConflictError) throw new AgentToolApiError(409, 'turn_conflict', error.message);
    throw error;
  }
  if (reserved.run.context) return reserved.run.context;

  // 先从总账装配本轮之前的记忆，再追加本轮 user visible message。
  const memoryCfg = resolveMemoryConfig(route.memory);
  const threadMemory = memoryCfg.summary_enabled
    ? await deps.toolProxyDeps.configStore!.conversations.getThreadMemory(threadId)
    : { summary: null, summary_upto_id: 0 };
  const recentRaw = await deps.toolProxyDeps.configStore!.conversations.recentMessagesAfter(threadId, threadMemory.summary_upto_id, memoryCfg.recent_messages);
  const recent = trimRecent(recentRaw, memoryCfg);
  const query = queryWithPage(input);
  const [knowledge, selected] = await Promise.all([
    knowledgeFor(deps, route, query),
    searchAgentToolsFor(deps.toolProxyDeps, auth, route.route_key, query, activeLimit),
  ]);
  const profile = profileFor(route, catalog, activeLimit);
  const profileBody = profile['profile'] as Record<string, unknown>;
  const context: Record<string, unknown> = {
    schema_version: AGENT_TURN_CONTEXT_SCHEMA,
    run_id: reserved.run.run_id,
    profile_revision: profileBody['revision'],
    capability_revision: selected.capability_revision,
    context: {
      instructions: profileBody['instructions'],
      page_context: input.page_context ?? {},
      renderers: input.renderers ?? [],
      memory: { summary: safeText(threadMemory.summary, memoryCfg.summary_max_chars) || null, recent },
      memory_refs: [{ thread_id: threadId, summary_upto_id: threadMemory.summary_upto_id, prior_messages: recent.length }],
      knowledge: knowledge.items,
      knowledge_refs: knowledge.refs,
      governance: profileBody['governance'],
    },
    active_tools: selected.tools,
  };
  let finalized: AgentClientRunRecord;
  try {
    finalized = await repo.finalizeTurn({
      run_id: reserved.run.run_id, session_id: auth.session.session_id, client_app_id: auth.client.app_id,
      request_hash: requestHash, context, principal_id: safeText(auth.session.principal.id, 64),
    });
  } catch (error) {
    if (error instanceof AgentClientRuntimeConflictError) throw new AgentToolApiError(409, 'turn_conflict', error.message);
    throw error;
  }
  await deps.stateStore.appendAudit({
    ts: deps.toolProxyDeps.now(), job_id: finalized.run_id, request_id: input.client_turn_id,
    event: 'agent_client_turn_context_ready',
    detail: { agent_run_id: finalized.run_id, thread_id: finalized.thread_id, route: route.route_key, client_app_id: auth.client.app_id, agent_session_id: auth.session.session_id, active_tools: selected.tools.length },
  }).catch(() => undefined);
  return finalized.context ?? context;
}

export async function searchAgentCapabilitiesFor(
  deps: AgentClientRuntimeDeps,
  auth: AgentToolAuthContext,
  routeKey: string,
  input: { query?: string; limit?: number; run_id?: string },
): Promise<Record<string, unknown>> {
  let query = input.query === undefined ? '' : strictClientText(input.query, 'query', 2000);
  if (!query.trim() && !input.run_id) throw new AgentToolApiError(400, 'invalid_request', 'query is required when run_id is not provided.');
  const { activeLimit } = await authorizedRuntime(deps, auth, routeKey);
  if (input.run_id) {
    const runId = safeRunId(input.run_id);
    const run = await deps.toolProxyDeps.configStore?.agentClientRuntime?.getRun(runId, auth.session.session_id, auth.client.app_id);
    if (!run || run.route_key !== routeKey) throw new AgentToolApiError(404, 'run_not_found', 'The run was not found for this Agent Session and route.');
    if (!query.trim()) query = run.user_input;
  }
  if (!query.trim()) throw new AgentToolApiError(400, 'invalid_request', 'The bound run does not contain a usable query.');
  const limit = Math.min(Math.max(Math.round(Number(input.limit) || activeLimit), 1), 12);
  return { ...await searchAgentToolsFor(deps.toolProxyDeps, auth, routeKey, query, limit) };
}

function safeUsage(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const known = new Set(['input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens', 'tool_calls', 'cost_usd']);
  if (Object.keys(value).some((key) => !known.has(key))) throw new AgentToolApiError(400, 'invalid_request', 'usage contains undeclared fields.');
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 0) throw new AgentToolApiError(400, 'invalid_request', `usage.${key} must be a non-negative number.`);
    out[key] = number;
  }
  return out;
}

export async function completeAgentRunFor(
  deps: AgentClientRuntimeDeps,
  auth: AgentToolAuthContext,
  runIdRaw: string,
  raw: AgentRunCompleteInput,
): Promise<Record<string, unknown>> {
  const runId = safeRunId(runIdRaw);
  const assistantMessageId = safeId(raw.assistant_message_id, 'assistant_message_id');
  const output = strictClientText(raw.content, 'content', 64_000, true);
  if (!['completed', 'failed', 'cancelled'].includes(raw.status)) throw new AgentToolApiError(400, 'invalid_request', 'status is invalid.');
  const model = raw.model === undefined ? undefined : strictClientText(raw.model, 'model', 191);
  const runtime = raw.runtime === undefined ? undefined : strictClientText(raw.runtime, 'runtime', 191);
  const usage = safeUsage(raw.usage);
  const completionHash = hash({ schema: AGENT_RUN_COMPLETION_SCHEMA, assistant_message_id: assistantMessageId, status: raw.status, content: output, model: model ?? null, runtime: runtime ?? null, usage: usage ?? null });
  const repo = deps.toolProxyDeps.configStore?.agentClientRuntime;
  if (!repo) throw new AgentToolApiError(503, 'agent_runtime_unavailable', 'Agent Client Runtime requires the MySQL control plane.');
  let completed;
  try {
    completed = await repo.completeRun({
      run_id: runId, session_id: auth.session.session_id, client_app_id: auth.client.app_id,
      completion_hash: completionHash, assistant_message_id: assistantMessageId, status: raw.status,
      assistant_output: output, ...(model !== undefined ? { model } : {}), ...(runtime !== undefined ? { runtime } : {}), ...(usage ? { usage } : {}),
    });
  } catch (error) {
    if (error instanceof AgentClientRuntimeConflictError) throw new AgentToolApiError(409, 'run_completion_conflict', error.message);
    if ((error as { code?: string })?.code === 'ER_DUP_ENTRY') throw new AgentToolApiError(409, 'assistant_message_conflict', 'assistant_message_id is already bound to a different run.');
    throw error;
  }
  await deps.stateStore.appendAudit({
    ts: deps.toolProxyDeps.now(), job_id: runId, request_id: assistantMessageId, event: 'agent_client_run_completed',
    detail: { agent_run_id: runId, thread_id: completed.run.thread_id, route: completed.run.route_key, status: completed.run.status, idempotent_replay: !completed.created },
  }).catch(() => undefined);
  return {
    schema_version: AGENT_RUN_COMPLETION_SCHEMA,
    run_id: runId,
    assistant_message_id: assistantMessageId,
    status: completed.run.status,
    idempotent_replay: !completed.created,
    completed_at: completed.run.completed_at,
  };
}
