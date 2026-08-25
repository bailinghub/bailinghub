import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../app/http';
import type { Principal } from '../app/auth';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { authenticateAgentAccess } from './agent-auth';

export interface AgentApiHttpDeps {
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  handleRun(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void>;
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
