export const EXACT_OPERATION_ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function mergeExactOperationIds(...groups: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const raw of group) {
      const operationId = String(raw).trim();
      if (!EXACT_OPERATION_ID_RE.test(operationId) || seen.has(operationId)) continue;
      seen.add(operationId);
      merged.push(operationId);
    }
  }
  return merged;
}

export function includesAllCurrentOperationIds(selected: ReadonlyArray<string>, current: ReadonlyArray<string>): boolean {
  if (!current.length) return false;
  const selectedSet = new Set(selected);
  return current.every((operationId) => selectedSet.has(operationId));
}
