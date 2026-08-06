import type { TargetDef } from '../contracts/types';
import { defaultTargetRegistry, type TargetRegistry } from './registry';

export interface TargetConfigStoreLike {
  targets: { list(): Promise<TargetDef[]> };
}

export async function resolveTargetDef(
  configStore: TargetConfigStoreLike | null | undefined,
  name: string,
  targetRegistry: TargetRegistry = defaultTargetRegistry,
): Promise<TargetDef | null> {
  const fallback = targetRegistry.get(name);
  if (!configStore) return fallback;
  try {
    const found = (await configStore.targets.list()).find((target) => target.name === name);
    return found ?? fallback;
  } catch {
    return fallback;
  }
}
