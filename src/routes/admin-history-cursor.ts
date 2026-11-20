/** No parameters keeps the original oldest-first detail endpoint. */
export function readHistoryCursor(query: URLSearchParams, key: 'sequence' | 'id'): { after: number; before?: number | null } | null {
  const after = query.get(`after_${key}`);
  const before = query.get(`before_${key}`);
  const tail = query.get('tail');
  if (tail !== null) return tail === '1' && before === null && after === null ? { after: 0, before: null } : null;
  if (before !== null && after !== null) return null;
  const raw = before ?? after ?? '0';
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) return null;
  return before !== null ? { after: 0, before: value } : { after: value };
}
