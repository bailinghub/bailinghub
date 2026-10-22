import { queryText, type PageQuery } from './task-page-location';

export function readListLocation(query: PageQuery, prefix = '') {
  return { keyword: queryText(query[`${prefix}q`]).slice(0, 200), focus: queryText(query[`${prefix}focus`]).slice(0, 200) };
}

/** Search only caller-selected display fields; credentials must never be indexed. */
export function filterLocatedRows<T>(rows: T[], keyword: string, focus: string, id: (row: T) => string, text: (row: T) => string, relatedFocus = ''): T[] {
  const q = keyword.trim().toLocaleLowerCase();
  return rows.filter(row => focus ? (id(row) === focus || (relatedFocus !== '' && id(row) === relatedFocus)) : !q || text(row).toLocaleLowerCase().includes(q));
}

export interface ConsoleDestination { path: string; query: Record<string, string>; hash?: string }
export function diagnosticDestination(row: { area: string; id: string } | undefined, returnTo: string): ConsoleDestination | undefined {
  if (!row) return undefined;
  const query = { return_to: returnTo };
  const paths: Record<string, string> = { route: '/routes', route_audience: '/routes', credential: '/credentials', client: '/clients', channel: '/channels', tool_provider: '/tools', storage_bucket: '/storage', chat_entry: '/chat', target: '/targets', project: '/projects', kb_base: '/kb' };
  // route_auto is either a client with no candidates or an explicit pair of ambiguous routes.
  if (row.area === 'route_auto') {
    const pair = row.id.split('<->');
    if (pair.length === 2 && pair[0] && pair[1]) return { path: '/routes', query: { ...query, q: pair[0], focus: pair[0], related: pair[1] } };
    if (pair.length === 1) return { path: '/clients', query: { ...query, q: row.id, focus: row.id } };
    return undefined;
  }
  const path = paths[row.area];
  if (path) return { path, query: { ...query, q: row.id, focus: row.id } };
  if (row.area === 'alert_rule') return { path: '/channels', query: { ...query, alert_q: row.id, alert_focus: row.id }, hash: '#alert-rules' };
  if (row.area === 'executor_token') return { path: '/executors', query: { ...query, token_q: row.id, token_focus: row.id }, hash: '#executor-tokens' };
  if (row.area === 'runtime_dispatch') return { path: '/executors', query, hash: '#dispatch' };
  if (row.area === 'runtime_executor') return { path: '/executors', query: { ...query, ...(row.id === 'offline' ? { state: 'offline' } : { target: row.id }) }, hash: '#executor-instances' };
  if (row.area === 'runtime_jobs') return { path: '/runs', query: { ...query, tab: 'jobs', ...(row.id === 'error_burst' ? { run_status: 'error' } : row.id === 'queued_backlog' ? { run_status: 'queued' } : {}) } };
  if (row.area === 'runtime_delivery') return { path: '/runs', query: { ...query, tab: 'outbox', outbox_kind: 'delivery-dlq' } };
  if (row.area === 'system') return { path: '/system', query };
  return undefined;
}
