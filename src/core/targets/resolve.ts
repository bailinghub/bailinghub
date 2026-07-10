import type { TargetDef } from '../contracts/types';
import { getTargetDef } from './registry';

export interface TargetConfigStoreLike {
  targets: { list(): Promise<TargetDef[]> };
}

export async function resolveTargetDef(configStore: TargetConfigStoreLike | null | undefined, name: string): Promise<TargetDef | null> {
  const fallback = getTargetDef(name);
  if (!configStore) return fallback;
  try {
    const found = (await configStore.targets.list()).find((target) => target.name === name);
    return found ?? fallback;
  } catch {
    return fallback;
  }
}
