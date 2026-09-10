import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, send } from '../app/http';
import { agentSetupRevision, agentSetupView } from '../core/config/agent-setup';
import { prepareRouteConfig } from '../core/config/route-config';
import type { Route } from '../core/contracts/types';
import { defaultTargetRegistry } from '../core/targets/registry';
import type { AdminDispatchConfigApiDeps } from './admin-dispatch-config';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Called only after the parent admin routes:read/routes:write gate. */
export async function handleAdminAgentSetupFor(
  deps: AdminDispatchConfigApiDeps,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const match = path.match(/^\/admin\/api\/routes\/([^/]+)\/agent-setup$/);
  if (!match || !deps.configStore) return false;
  const store = deps.configStore;
  let key: string;
  try { key = decodeURIComponent(match[1]!); }
  catch { send(res, 400, { error: 'invalid_request' }); return true; }
  if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(key)) { send(res, 400, { error: 'invalid_request' }); return true; }
  if (method !== 'GET' && method !== 'PUT') { send(res, 405, { error: 'method_not_allowed' }); return true; }
  const current = await store.routes.get(key);
  if (!current) { send(res, 404, { error: 'route_not_found' }); return true; }
  if (method === 'GET') { send(res, 200, agentSetupView(current)); return true; }
  if (typeof store.routes.compareAndSetAgentSetup !== 'function') {
    send(res, 503, { error: 'agent_setup_unsupported' }); return true;
  }
  let body: Record<string, unknown> | null;
  try { body = record(await readBody(req, 256 * 1024)); }
  catch { send(res, 400, { error: 'invalid_request' }); return true; }
  const fields = ['expected_revision', 'agent_client', 'tool_sources', 'agent_direct'];
  if (!body || Object.keys(body).length !== fields.length || Object.keys(body).some((name) => !fields.includes(name))
    || typeof body.expected_revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expected_revision)
    || (body.agent_client !== null && !record(body.agent_client)) || !Array.isArray(body.tool_sources)
    || (body.agent_direct !== null && !record(body.agent_direct))) {
    send(res, 400, { error: 'invalid_request' }); return true;
  }
  if (agentSetupRevision(current) !== body.expected_revision) { send(res, 409, { error: 'agent_setup_conflict' }); return true; }
  const tools = { ...current.tools };
  if (body.tool_sources.length) tools.sources = body.tool_sources;
  else delete tools.sources;
  if (body.agent_direct !== null) tools.agent_direct = body.agent_direct;
  else delete tools.agent_direct;
  const registry = deps.targetRegistry ?? defaultTargetRegistry;
  const prepared = await prepareRouteConfig({
    ...current,
    agent_client: (body.agent_client ?? undefined) as Route['agent_client'],
    tools,
  }, {
    targetExists: (name) => registry.isKnown(name), targetNeedsProject: (name) => registry.needsProject(name),
    toolProviderExists: async (name) => !!(await store.toolProviders.get(name)),
  }, { defaultProfile: deps.defaultProfile });
  if (!prepared.ok) { send(res, 400, { error: prepared.error }); return true; }
  const result = await store.routes.compareAndSetAgentSetup(key, body.expected_revision, {
    agent_client: prepared.route.agent_client, tools: prepared.route.tools,
  });
  if (result.status === 'conflict') { send(res, 409, { error: 'agent_setup_conflict' }); return true; }
  if (result.status === 'not_found') { send(res, 404, { error: 'route_not_found' }); return true; }
  send(res, 200, agentSetupView(result.route));
  return true;
}
