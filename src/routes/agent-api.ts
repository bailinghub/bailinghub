import type { IncomingMessage, ServerResponse } from 'node:http';
import { PayloadTooLargeError, readBody, send } from '../app/http';
import type { Principal } from '../app/auth';
import type { ToolProxyDeps } from '../app/tool-proxy';
import {
  AgentToolApiError,
  invokeAgentToolFor,
  listAgentToolsFor,
  resumeAgentToolFor,
  type InvokeAgentToolInput,
  type ResumeAgentToolInput,
} from '../app/agent-tool-invocations';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { authenticateAgentAccess } from './agent-auth';
import type { KbService } from '../services/kb';
import {
  completeAgentRunFor,
  getAgentWorkspaceBootstrapFor,
  listAgentWorkspacesFor,
  prepareAgentTurnFor,
  searchAgentCapabilitiesFor,
  type AgentClientRuntimeDeps,
} from '../app/agent-client-runtime';

export interface AgentApiHttpDeps {
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  isPaused: () => boolean;
  handleRun(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void>;
  /** 未注入时仅关闭新的无模型直调面，保持旧宿主的 Agent Auth / run 兼容。 */
  toolProxyDeps?: ToolProxyDeps;
  kbService?: KbService | null;
}

// 64000 个 UTF-16 code units 在 JSON 中最坏可被转义为约 384 KB；512 KiB 还可容纳
// Turn 的 16 KiB page_context、renderer/标识字段与固定 envelope，同时保留预解析内存上限。
const AGENT_RUNTIME_JSON_BODY_MAX_BYTES = 512 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactFields(body: Record<string, unknown>, expected: string[]): boolean {
  const allowed = new Set(expected);
  const fields = Object.keys(body);
  return fields.length === expected.length && fields.every((key) => allowed.has(key));
}

function declaredFields(body: Record<string, unknown>, allowedFields: string[], requiredFields: string[] = []): boolean {
  const allowed = new Set(allowedFields);
  return Object.keys(body).every((key) => allowed.has(key)) && requiredFields.every((key) => Object.prototype.hasOwnProperty.call(body, key));
}

function sendAgentToolError(res: ServerResponse, error: unknown): void {
  if (error instanceof AgentToolApiError) {
    send(res, error.statusCode, { error: error.code, message: error.message });
    return;
  }
  send(res, 500, { error: 'agent_tool_internal_error', message: 'The governed Agent tool operation failed.' });
}

async function readAgentToolBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  try {
    const body = record(await readBody(req, maxBytes));
    if (!body) {
      send(res, 400, { error: 'invalid_request', message: 'The request body must be a JSON object.' });
      return null;
    }
    return body;
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      send(res, 413, { error: 'arguments_too_large', message: `The Agent tool request exceeds ${maxBytes} bytes.` });
    } else {
      send(res, 400, { error: 'invalid_request', message: 'The request body must be valid JSON.' });
    }
    return null;
  }
}

/** Dedicated local-Agent API. Agent bearer tokens are never admitted to the legacy /run surface. */
export async function handleAgentApiHttpFor(deps: AgentApiHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/agent-api/')) return false;
  res.setHeader('cache-control', 'no-store');
  const auth = await authenticateAgentAccess(deps, req, url);
  if (!auth) { send(res, 401, { error: 'unauthorized' }); return true; }
  const principal: Principal = { kind: 'agent', session: auth.session, client: auth.client };
  const method = req.method ?? 'GET';
  const runtimeDeps = (): AgentClientRuntimeDeps | null => deps.toolProxyDeps
    ? { toolProxyDeps: deps.toolProxyDeps, kbService: deps.kbService ?? null, stateStore: deps.stateStore }
    : null;
  if (method === 'GET' && path === '/agent-api/v1/workspaces') {
    const runtime = runtimeDeps();
    if (!runtime) { send(res, 503, { error: 'agent_runtime_unavailable' }); return true; }
    try { send(res, 200, await listAgentWorkspacesFor(runtime, auth)); }
    catch (error) { sendAgentToolError(res, error); }
    return true;
  }
  const bootstrapMatch = method === 'GET' ? path.match(/^\/agent-api\/v1\/workspaces\/([a-z0-9][a-z0-9_-]{1,63})\/bootstrap$/) : null;
  if (bootstrapMatch) {
    const runtime = runtimeDeps();
    if (!runtime) { send(res, 503, { error: 'agent_runtime_unavailable' }); return true; }
    try { send(res, 200, await getAgentWorkspaceBootstrapFor(runtime, auth, bootstrapMatch[1]!)); }
    catch (error) { sendAgentToolError(res, error); }
    return true;
  }
  const turnMatch = method === 'POST' ? path.match(/^\/agent-api\/v1\/workspaces\/([a-z0-9][a-z0-9_-]{1,63})\/turns$/) : null;
  if (turnMatch) {
    const runtime = runtimeDeps();
    if (!runtime) { send(res, 503, { error: 'agent_runtime_unavailable' }); return true; }
    if (deps.isPaused()) { send(res, 503, { error: 'hub_paused', status: 'paused' }); return true; }
    const body = await readAgentToolBody(req, res, AGENT_RUNTIME_JSON_BODY_MAX_BYTES);
    if (!body) return true;
    if (!declaredFields(body, ['client_conversation_id', 'client_turn_id', 'user_message_id', 'user_input', 'page_context', 'renderers'], ['client_conversation_id', 'client_turn_id', 'user_message_id', 'user_input'])
      || typeof body['client_conversation_id'] !== 'string'
      || typeof body['client_turn_id'] !== 'string'
      || typeof body['user_message_id'] !== 'string'
      || typeof body['user_input'] !== 'string'
      || (body['page_context'] !== undefined && !record(body['page_context']))
      || (body['renderers'] !== undefined && (!Array.isArray(body['renderers']) || !body['renderers'].every((value) => typeof value === 'string')))) {
      send(res, 400, { error: 'invalid_request', message: 'The Agent turn contains missing or undeclared fields.' }); return true;
    }
    try {
      send(res, 200, await prepareAgentTurnFor(runtime, auth, turnMatch[1]!, {
        client_conversation_id: body['client_conversation_id'], client_turn_id: body['client_turn_id'],
        user_message_id: body['user_message_id'], user_input: body['user_input'],
        ...(record(body['page_context']) ? { page_context: record(body['page_context'])! } : {}),
        ...(Array.isArray(body['renderers']) ? { renderers: body['renderers'] as string[] } : {}),
      }));
    } catch (error) { sendAgentToolError(res, error); }
    return true;
  }
  const searchMatch = method === 'POST' ? path.match(/^\/agent-api\/v1\/workspaces\/([a-z0-9][a-z0-9_-]{1,63})\/capabilities\/search$/) : null;
  if (searchMatch) {
    const runtime = runtimeDeps();
    if (!runtime) { send(res, 503, { error: 'agent_runtime_unavailable' }); return true; }
    const body = await readAgentToolBody(req, res, 8 * 1024);
    if (!body) return true;
    if (!declaredFields(body, ['query', 'limit', 'run_id'])
      || (body['query'] !== undefined && typeof body['query'] !== 'string')
      || (body['limit'] !== undefined && (!Number.isInteger(body['limit']) || Number(body['limit']) < 1 || Number(body['limit']) > 12))
      || (body['run_id'] !== undefined && typeof body['run_id'] !== 'string')) {
      send(res, 400, { error: 'invalid_request', message: 'The capability search contains undeclared or invalid fields.' }); return true;
    }
    try {
      send(res, 200, await searchAgentCapabilitiesFor(runtime, auth, searchMatch[1]!, {
        ...(typeof body['query'] === 'string' ? { query: body['query'] } : {}),
        ...(typeof body['limit'] === 'number' ? { limit: body['limit'] } : {}),
        ...(typeof body['run_id'] === 'string' ? { run_id: body['run_id'] } : {}),
      }));
    } catch (error) { sendAgentToolError(res, error); }
    return true;
  }
  const completeMatch = method === 'POST' ? path.match(/^\/agent-api\/v1\/runs\/([0-9a-f-]{36})\/complete$/i) : null;
  if (completeMatch) {
    const runtime = runtimeDeps();
    if (!runtime) { send(res, 503, { error: 'agent_runtime_unavailable' }); return true; }
    const body = await readAgentToolBody(req, res, AGENT_RUNTIME_JSON_BODY_MAX_BYTES);
    if (!body) return true;
    if (!declaredFields(body, ['assistant_message_id', 'status', 'content', 'model', 'runtime', 'usage'], ['assistant_message_id', 'status', 'content'])
      || typeof body['assistant_message_id'] !== 'string'
      || typeof body['status'] !== 'string'
      || typeof body['content'] !== 'string'
      || (body['model'] !== undefined && typeof body['model'] !== 'string')
      || (body['runtime'] !== undefined && typeof body['runtime'] !== 'string')
      || (body['usage'] !== undefined && !record(body['usage']))) {
      send(res, 400, { error: 'invalid_request', message: 'The run completion contains missing or undeclared fields.' }); return true;
    }
    try {
      send(res, 200, await completeAgentRunFor(runtime, auth, completeMatch[1]!, {
        assistant_message_id: body['assistant_message_id'],
        status: body['status'] as 'completed' | 'failed' | 'cancelled',
        content: body['content'],
        ...(typeof body['model'] === 'string' ? { model: body['model'] } : {}),
        ...(typeof body['runtime'] === 'string' ? { runtime: body['runtime'] } : {}),
        ...(record(body['usage']) ? { usage: record(body['usage'])! } : {}),
      }));
    } catch (error) { sendAgentToolError(res, error); }
    return true;
  }
  if (method === 'GET' && path === '/agent-api/v1/tools') {
    if (!deps.toolProxyDeps) { send(res, 503, { error: 'agent_tools_unavailable' }); return true; }
    const route = String(url.searchParams.get('route') ?? '');
    try { send(res, 200, await listAgentToolsFor(deps.toolProxyDeps, auth, route)); }
    catch (error) { sendAgentToolError(res, error); }
    return true;
  }
  if (method === 'POST' && path === '/agent-api/v1/tool-invocations') {
    if (!deps.toolProxyDeps) { send(res, 503, { error: 'agent_tools_unavailable' }); return true; }
    if (deps.isPaused()) { send(res, 503, { error: 'hub_paused', status: 'paused' }); return true; }
    const body = await readAgentToolBody(req, res, 16 * 1024);
    if (!body) return true;
    if (!body
        || !exactFields(body, ['invocation_id', 'route', 'capability_revision', 'agent_run_id', 'tool', 'arguments'])
        || typeof body['invocation_id'] !== 'string'
        || typeof body['route'] !== 'string'
        || typeof body['capability_revision'] !== 'string'
        || typeof body['agent_run_id'] !== 'string'
        || typeof body['tool'] !== 'string'
        || !record(body['arguments'])) {
      send(res, 400, { error: 'invalid_request', message: 'The Agent tool invocation contains undeclared fields.' }); return true;
    }
    const input: InvokeAgentToolInput = {
      invocation_id: body['invocation_id'],
      route: body['route'],
      capability_revision: body['capability_revision'],
      agent_run_id: body['agent_run_id'],
      tool: body['tool'],
      arguments: record(body['arguments'])!,
    };
    try { send(res, 200, await invokeAgentToolFor(deps.toolProxyDeps, auth, input)); }
    catch (error) { sendAgentToolError(res, error); }
    return true;
  }
  const resumeMatch = method === 'POST' ? path.match(/^\/agent-api\/v1\/tool-invocations\/([a-f0-9]{64})\/resume$/) : null;
  if (resumeMatch) {
    if (!deps.toolProxyDeps) { send(res, 503, { error: 'agent_tools_unavailable' }); return true; }
    if (deps.isPaused()) { send(res, 503, { error: 'hub_paused', status: 'paused' }); return true; }
    const body = await readAgentToolBody(req, res, 1024);
    if (!body) return true;
    if (!body || !exactFields(body, [])) {
      send(res, 400, { error: 'invalid_request', message: 'The Agent tool resume request contains undeclared fields.' }); return true;
    }
    const input: ResumeAgentToolInput = {
      invocation_id: resumeMatch[1]!,
    };
    try { send(res, 200, await resumeAgentToolFor(deps.toolProxyDeps, auth, input)); }
    catch (error) { sendAgentToolError(res, error); }
    return true;
  }
  if (method === 'POST' && path === '/agent-api/v1/run') {
    await deps.handleRun(req, res, principal);
    return true;
  }
  const jobMatch = method === 'GET' ? path.match(/^\/agent-api\/v1\/jobs\/([0-9a-f-]{36})$/i) : null;
  if (jobMatch) {
    const job = await deps.stateStore.getJob(jobMatch[1]!);
    if (!job || job.agent_session_id !== auth.session.session_id) {
      send(res, 404, { error: 'not_found' }); return true;
    }
    send(res, 200, job);
    return true;
  }
  send(res, 404, { error: 'not_found' });
  return true;
}
