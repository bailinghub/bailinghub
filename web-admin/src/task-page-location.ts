import { JOB_STATUSES } from '../../src/core/contracts/types';

export type PageQuery = Record<string, string | null | (string | null)[] | undefined>;
export type RunsTab = 'threads' | 'runs' | 'trace' | 'notifications';
export function queryText(value: PageQuery[string]): string { return typeof value === 'string' ? value : ''; }
export function patchTaskQuery(query: PageQuery, patch: Record<string, string | undefined>): PageQuery {
  const result = { ...query };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') delete result[key]; else result[key] = value;
  }
  return result;
}
export function runsTabQuery(tab: RunsTab): string {
  return { threads: 'conversations', runs: 'jobs', trace: 'trace', notifications: 'outbox' }[tab];
}
export function readRunsLocation(query: PageQuery) {
  const tabs: Record<string, RunsTab> = { conversations: 'threads', threads: 'threads', jobs: 'runs', runs: 'runs', trace: 'trace', outbox: 'notifications', notifications: 'notifications' };
  const job = queryText(query.job);
  const thread = queryText(query.thread);
  const conversation = queryText(query.conversation);
  const tab = tabs[queryText(query.tab)] || (job ? 'trace' : 'threads');
  return { tab, view: queryText(query.view) === 'legacy' || (!queryText(query.view) && thread && !conversation) ? 'legacy' as const : 'audit' as const,
    thread: /^[1-9]\d*$/.test(thread) ? Number(thread) : null, conversation, turn: queryText(query.turn),
    threadQ: queryText(query.thread_q), traceQ: queryText(query.trace_q) || job,
    detail: queryText(query.detail) || (!queryText(query.tab) && job ? job : '') };
}
export const RUN_FILTER_STATUSES = JOB_STATUSES;
export interface RunFilters { status: string; route: string; period: 'all' | '24h' | '7d' }
export interface FilterableRun { status?: string; route_key?: string | null; dispatch?: { route_key?: string }; created_at?: string }
export function readRunFilters(query: PageQuery): RunFilters {
  const status = queryText(query.run_status), period = queryText(query.run_period);
  return { status: (RUN_FILTER_STATUSES as readonly string[]).includes(status) ? status : '', route: queryText(query.run_route).trim(),
    period: period === '24h' || period === '7d' ? period : 'all' };
}
export function runRouteKey(row: FilterableRun): string { return String(row.route_key || row.dispatch?.route_key || ''); }
/** Filters only the supplied, already loaded rows. No content search or server query is implied. */
export function filterLoadedRuns<T extends FilterableRun>(rows: T[], filters: RunFilters, now: number): T[] {
  const windowMs = filters.period === '24h' ? 86400000 : filters.period === '7d' ? 7 * 86400000 : undefined;
  return rows.filter(row => {
    if (filters.status && row.status !== filters.status) return false;
    if (filters.route && runRouteKey(row) !== filters.route) return false;
    if (windowMs !== undefined) {
      const created = Date.parse(row.created_at || '');
      if (!Number.isFinite(created) || created < now - windowMs || created > now) return false;
    }
    return true;
  });
}
export const OUTBOX_KINDS = ['callback', 'delivery', 'approval-notification', 'delivery-dlq'] as const;
export const OUTBOX_STATUSES = ['pending', 'processing', 'completed', 'skipped', 'failed', 'uncertain'] as const;
export function readOutboxLocation(query: PageQuery) {
  const kind = queryText(query.outbox_kind), status = queryText(query.outbox_status), rawPage = queryText(query.outbox_page);
  const page = /^\d+$/.test(rawPage) ? Number(rawPage) : 1;
  return { kind: (OUTBOX_KINDS as readonly string[]).includes(kind) ? kind : 'callback',
    status: (OUTBOX_STATUSES as readonly string[]).includes(status) ? status : '',
    page: Number.isSafeInteger(page) && page >= 1 && page <= 100000 ? page : 1 };
}
/** Return targets are router-relative paths, never URLs, API routes or protocol-relative links. */
export function safeTaskReturnPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\u0000-\u0020]/.test(value)) return undefined;
  try {
    const url = new URL(value, 'https://console.invalid');
    if (url.origin !== 'https://console.invalid' || !['/diagnostics', '/runs', '/agent-tasks', '/executors'].includes(url.pathname)) return undefined;
    return url.pathname + url.search + url.hash;
  } catch { return undefined; }
}
