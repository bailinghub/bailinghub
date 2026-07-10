import type { Job, Route } from '../core/contracts/types';
import { cfgStore } from './runtime';
import { type AllowedToolContext, resolveAllowedToolsFor } from './tool-context';

export async function resolveAllowedTools(job: Job, route: Route | null): Promise<AllowedToolContext | null> {
  return resolveAllowedToolsFor(cfgStore, job, route);
}
