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

export interface AgentApiHttpDeps {
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  isPaused: () => boolean;
  handleRun(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void>;
  /** 未注入时仅关闭新的无模型直调面，保持旧宿主的 Agent Auth / run 兼容。 */
  toolProxyDeps?: ToolProxyDeps;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactFields(body: Record<string, unknown>, expected: string[]): boolean {
  const allowed = new Set(expected);
  const fields = Object.keys(body);
  return fields.length === expected.length && fields.every((key) => allowed.has(key));
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
