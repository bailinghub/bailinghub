import { createHash } from 'node:crypto';
import type { Route } from '../contracts/types';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** Whole-route CAS detects concurrent edits while the repository writes only the two Agent setup columns. */
export function agentSetupRevision(route: Route): string {
  return createHash('sha256').update(JSON.stringify(canonical(route))).digest('hex');
}

export function agentSetupView(route: Route) {
  return {
    route_key: route.route_key,
    name: route.name,
    enabled: route.enabled,
    permission: route.permission,
    revision: agentSetupRevision(route),
    agent_client: route.agent_client ?? null,
    tool_sources: Array.isArray(route.tools?.sources) ? route.tools.sources : [],
    agent_direct: route.tools?.agent_direct ?? null,
  };
}

export interface AgentSetupUpdate {
  agent_client: Route['agent_client'];
  tools: Route['tools'];
}

export type AgentSetupUpdateResult = { status: 'updated'; route: Route }
  | { status: 'conflict' } | { status: 'not_found' };
