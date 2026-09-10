import { createHash } from 'node:crypto';
import type { Client } from '../contracts/types';

export interface ClientAgentSetup {
  enabled: boolean;
  agent_authorize_url: string | null;
  allowed_routes: string[];
}

export function clientAgentSetupRevision(client: ClientAgentSetup | Client): string {
  return createHash('sha256').update(JSON.stringify({
    enabled: client.enabled,
    agent_authorize_url: client.agent_authorize_url || null,
    allowed_routes: [...client.allowed_routes].sort(),
  })).digest('hex');
}

/** Only the existing client connection settings; never a token projection. */
export function clientAgentSetupView(client: Client): Record<string, unknown> {
  return {
    app_id: client.app_id, name: client.name,
    enabled: client.enabled, agent_authorize_url: client.agent_authorize_url || null,
    allowed_routes: client.allowed_routes, revision: clientAgentSetupRevision(client),
  };
}
