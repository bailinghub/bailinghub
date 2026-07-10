import type { Job } from '../contracts/types';

export function json(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

export function dt(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, '');
}

export function rowToJob(r: any): Job {
  const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) ?? undefined;
  return {
    job_id: r.job_id,
    request_id: r.request_id,
    status: r.status,
    target: r.target ?? undefined,
    profile: r.profile,
    project: r.project,
    source: r.source,
    client_app_id: r.client_app_id ?? undefined,
    thread_id: r.thread_id != null ? Number(r.thread_id) : undefined,
    session_id: r.session_id ?? undefined,
    input_preview: r.input_preview ?? '',
    input: r.input ?? undefined,
    report: parse(r.report),
    result: parse(r.result),
    raw_result: r.raw_result ?? undefined,
    usage: parse(r.usage),
    error: r.error ?? undefined,
    metadata: parse(r.metadata) ?? {},
    callback_url: r.callback_url ?? undefined,
    dispatch: parse(r.dispatch),
    attempts: r.attempts != null ? Number(r.attempts) : 0,
    run_after: r.run_after ? new Date(r.run_after).toISOString() : undefined,
    claimed_at: r.claimed_at ? new Date(r.claimed_at).toISOString() : undefined,
    lease_until: r.lease_until ? new Date(r.lease_until).toISOString() : undefined,
    executor_id: r.executor_id ?? undefined,
    dispatched_at: r.dispatched_at ? new Date(r.dispatched_at).toISOString() : undefined,
    claim_token: r.claim_token ?? undefined,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}
