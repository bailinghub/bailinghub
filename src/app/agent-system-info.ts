import { createHash } from 'node:crypto';
import type { AgentSystemInfo } from '../core/contracts/types';
import { routeAgentClientConfig, routeAgentSystemInfo } from '../core/config/route-config';
import { agentDirectToolsConfig } from '../core/config/tools-config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { resolveAgentRouteFor, type AgentToolAuthContext } from './agent-tool-invocations';

export const AGENT_SYSTEM_INFO_SCHEMA = 'bailing.agent-system-info.v1';

export interface AgentSystemInfoResponse {
  schema_version: typeof AGENT_SYSTEM_INFO_SCHEMA;
  binding: { client_app_id: string; session_id: string; workspace: string };
  metadata_status: 'configured' | 'missing';
  revision: string | null;
  system: AgentSystemInfo | null;
  tool_status: 'not_loaded';
  availability: 'unknown' | 'unavailable';
  unavailable_reason?: 'agent_client_disabled' | 'agent_direct_disabled';
}

/** Read only the selected route's product description; no tool, context or run services are used. */
export async function getAgentSystemInfoFor(
  configStore: ConfigStoreContract | null,
  auth: AgentToolAuthContext,
  workspace: string,
): Promise<AgentSystemInfoResponse> {
  const route = await resolveAgentRouteFor({ configStore }, auth, workspace);
  const system = routeAgentSystemInfo(route);
  const unavailableReason = !routeAgentClientConfig(route) ? 'agent_client_disabled'
    : !agentDirectToolsConfig(route.tools) ? 'agent_direct_disabled' : undefined;
  return {
    schema_version: AGENT_SYSTEM_INFO_SCHEMA,
    binding: { client_app_id: auth.client.app_id, session_id: auth.session.session_id, workspace: route.route_key },
    metadata_status: system ? 'configured' : 'missing',
    revision: system ? createHash('sha256').update(JSON.stringify({ schema_version: AGENT_SYSTEM_INFO_SCHEMA, system })).digest('hex') : null,
    system,
    tool_status: 'not_loaded',
    availability: unavailableReason ? 'unavailable' : 'unknown',
    ...(unavailableReason ? { unavailable_reason: unavailableReason } : {}),
  };
}
