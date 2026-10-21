import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApprovalContinuation, ApprovalContinuationDecisionOptions } from '../core/contracts/approval-continuation';
import type { Job, ToolApproval } from '../core/contracts/types';
import type { ApprovalLedgerContract, ConfigStoreContract } from '../infrastructure/config/configstore';
import { JsonlStore } from '../infrastructure/state/state-jsonl';
import { ApprovalLedger } from '../infrastructure/config/config-approval-ledger';
import { handleApprovalDecisionFor, type ApprovalDecisionDeps } from '../routes/approvals';
import { handleAdminRuntimeApiFor } from '../routes/admin-runtime';
import { continueApprovalDecisionFor, reconcileApprovalContinuationsFor, approvalContinuationMaintenanceSnapshotFor, type ApprovalContinuationDeps } from './approval-continuations';

class Response {
  statusCode = 0;
  body: Record<string, any> = {};
  writeHead(code: number): void { this.statusCode = code; }
  setHeader(): void {}
  end(raw: string | Buffer): void { this.body = JSON.parse(String(raw)); }
}

async function fixture(status: Job['status'] = 'done', direct = false) {
  const directory = await mkdtemp(join(tmpdir(), 'approval-continuation-'));
  const path = join(directory, 'state.jsonl');
  const store = new JsonlStore(path);
  await store.init();
  const now = () => new Date().toISOString();
  const job: Job = {
    job_id: randomUUID(), request_id: `fixture-${randomUUID()}`, status, target: 'llm', profile: 'general',
    project: '', source: 'synthetic', input_preview: '', metadata: { no_delivery: true }, created_at: now(), updated_at: now(),
  };
  if (direct) {
    const runId = randomUUID();
    job.request_id = `agent-tool:${'a'.repeat(64)}`;
    job.target = 'agent-tool-v1'; job.source = 'agent-tool:synthetic-app'; job.client_app_id = 'synthetic-app';
    job.agent_session_id = randomUUID(); job.on_behalf_of = 'synthetic-user'; job.session_id = runId;
    job.dispatch = { route_key: 'orders' };
    job.metadata = {
      agent_tool_job_marker: 'bailing.agent-tool-job.v1', agent_tool_call_v1: true,
      agent_invocation_id: 'a'.repeat(64), agent_run_id: runId, agent_route: 'orders', tool: 'refund_create',
      agent_tool: 'refund_create', agent_args_hash: 'a'.repeat(64), agent_capability_revision: 'b'.repeat(64),
      agent_execution_fingerprint: 'c'.repeat(64),
    };
  }
  await store.createJob(job);
  const approval: ToolApproval = {
    id: 7, job_id: job.job_id, request_id: job.request_id, provider: 'synthetic', tool: 'refund_create',
    scope: 'refund.create', risk: 'high', args_hash: 'a'.repeat(64), status: 'pending', created_at: now(),
  };
  let intent: ApprovalContinuation | null = null;
  let kicks = 0;
  const faults = { audit: false, queue: false, acknowledgement: false };
  const originalAudit = store.appendAudit.bind(store);
  const originalQueue = store.requeueApprovedJobOnce.bind(store);
  store.appendAudit = async (entry) => {
    if (faults.audit) throw new Error('synthetic audit unavailable');
    await originalAudit(entry);
  };
  store.requeueApprovedJobOnce = async (input) => {
    if (faults.queue) throw new Error('synthetic queue unavailable');
    return await originalQueue(input);
  };
  const ledger = {
    get: async () => ({ ...approval }), getByDecisionId: async () => null,
    list: async () => [{ ...approval }],
    decideWithContinuation: async (_id: number, decision: 'approved' | 'denied', by: string, opts: ApprovalContinuationDecisionOptions) => {
      if (approval.status !== 'pending') return approval.status === decision && approval.decision_id === opts.decision_id ? 'same' : 'conflict';
      approval.status = decision; approval.decision_id = opts.decision_id;
      intent = {
        schema_version: 'bailing.approval-continuation.v1', approval_id: approval.id,
        decision_key: opts.decision_id ?? `console:${approval.id}`, decision_id: opts.decision_id, decision,
        job_id: approval.job_id, request_id: approval.request_id, args_hash: approval.args_hash,
        tool: approval.tool, scope: approval.scope, by, ...opts, audit_recorded: false, completed: false,
      };
      return 'decided';
    },
    getContinuation: async () => intent && { ...intent },
    pendingContinuations: async () => intent && !intent.completed ? [{ ...intent }] : [],
    markContinuationAuditRecorded: async () => { intent!.audit_recorded = true; },
    completeContinuation: async () => {
      if (faults.acknowledgement) throw new Error('synthetic acknowledgement unavailable');
      intent!.completed = true;
    },
  } as unknown as ApprovalLedgerContract;
  const configStore = { approvals: ledger } as unknown as ConfigStoreContract;
  const deps: ApprovalDecisionDeps = {
    cfg: { server: { token: 'fixture-only' } } as ApprovalDecisionDeps['cfg'], configStore,
    stateStore: store, now, sleep: async () => {}, secretForJob: async () => 'fixture-only',
    engineRuntime: { kickInhubScheduler: () => { kicks++; } },
  };
  function body(decision: 'approved' | 'denied' = 'approved') {
    return { kind: 'tool_approval_decision', schema_version: 'bailing.approval-decision.v1',
      approval_id: approval.id, job_id: approval.job_id, request_id: approval.request_id,
      args_hash: approval.args_hash, decision, decision_id: 'decision-fixture', approver: 'fixture-operator' };
  }
  async function call(decision: 'approved' | 'denied' = 'approved') {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body(decision)))]), {
      method: 'POST', headers: { authorization: 'Bearer fixture-only' },
    });
    const res = new Response();
    await handleApprovalDecisionFor(deps, req as IncomingMessage, res as unknown as ServerResponse, approval.id, new URL('http://fixture/approvals/7/decision'));
    return res;
  }
  async function consoleCall(action: 'approve' | 'deny' = 'approve') {
    const req = Object.assign(Readable.from([]), { method: 'POST', headers: {} });
    const res = new Response();
    await handleAdminRuntimeApiFor({ configStore, stateStore: store, now, isPaused: () => false,
      queueStats: () => ({}), channelSend: async () => ({ ok: true }),
      engineRuntime: { ...deps.engineRuntime, requeueForRerun: async () => { throw new Error('unfenced requeue forbidden'); } },
    }, 'POST', `/admin/api/tool-approvals/7/${action}`, req as IncomingMessage, res as unknown as ServerResponse,
    { kind: 'admin', via: 'session', role: 'admin', username: 'fixture-operator' });
    return res;
  }
  async function consoleRead(pathname: string) {
    const req = Object.assign(Readable.from([]), { method: 'GET', headers: {}, url: pathname });
    const res = new Response();
    await handleAdminRuntimeApiFor({ configStore, stateStore: store, now, isPaused: () => false,
      queueStats: () => ({}), channelSend: async () => ({ ok: true }),
      engineRuntime: { ...deps.engineRuntime, requeueForRerun: async () => { throw new Error('read must not requeue'); } },
    }, 'GET', pathname.split('?')[0]!, req as IncomingMessage, res as unknown as ServerResponse,
    { kind: 'admin', via: 'session', role: 'admin', username: 'fixture-operator' });
    return res;
  }
  return { directory, path, store, job, approval, ledger, deps, faults, call, consoleCall, consoleRead,
    intent: () => intent, kicks: () => kicks,
    close: () => rm(directory, { recursive: true, force: true }) };
}

test('approval maintenance snapshots report page failures and isolated run history without enumerating records', async () => {
  const one = await fixture(), two = await fixture();
  try {
    one.faults.queue = true;
    await one.call();
    assert.equal(await reconcileApprovalContinuationsFor(one.deps), 0);
    const snapshot = approvalContinuationMaintenanceSnapshotFor(one.deps)!;
    assert.deepEqual(snapshot.progress, { scanned: 1, completed: 0, pending: 0, failed: 1 });
    assert.equal(snapshot.work.kinds[0]!.completed, 1); // A completed pass can retain failed individual intents.
    assert.equal(snapshot.work.kinds[0]!.failed, 0);
    assert.equal(approvalContinuationMaintenanceSnapshotFor(two.deps)!.work.kinds[0]!.completed, 0);
    snapshot.progress!.failed = 1000;
    let reads = 0;
    one.ledger.pendingContinuations = async () => { reads++; throw new Error('PRIVATE_LEDGER_TOKEN_JOB_ID'); };
    assert.equal(approvalContinuationMaintenanceSnapshotFor(one.deps)!.progress!.failed, 1);
    assert.equal(reads, 0);
    await assert.rejects(reconcileApprovalContinuationsFor(one.deps));
    const failed = approvalContinuationMaintenanceSnapshotFor(one.deps)!;
    assert.equal(reads, 1);
    assert.equal(failed.work.kinds[0]!.failed, 1);
    assert.equal(failed.work.kinds[0]!.inFlight, 0);
    assert(failed.work.kinds[0]!.lastFailedAt);
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_LEDGER|TOKEN|JOB_ID/);
  } finally { await one.close(); await two.close(); }
});

for (const failure of ['audit', 'queue'] as const) test(`decision submitted then ${failure} fails: identical callback resumes only original job`, async () => {
  const h = await fixture();
  try {
    h.faults[failure] = true;
    const first = await h.call();
    assert.equal(first.statusCode, 503);
    assert.equal(first.body.decision_recorded, true);
    assert.equal(h.approval.status, 'approved');
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'done');
    h.faults[failure] = false;
    const retry = await h.call();
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.body.idempotent, true);
    assert.equal(retry.body.rerun, true);
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'queued');
    assert.equal(h.intent()?.completed, true);
    assert.equal(h.kicks(), 1);
  } finally { await h.close(); }
});

test('queue succeeds but outbox ack is lost: new run completes and JSONL restart never requeues it again', async () => {
  const h = await fixture();
  try {
    h.faults.acknowledgement = true;
    assert.equal((await h.call()).statusCode, 503);
    await h.store.updateJob(h.job.job_id, { status: 'done', result: { text: 'confirmed' }, metadata: {} });
    const reopened = new JsonlStore(h.path); await reopened.init();
    h.deps.stateStore = reopened;
    h.faults.acknowledgement = false;
    const retry = await h.call();
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.body.rerun, false);
    assert.equal((await reopened.getJob(h.job.job_id))?.status, 'done');
    assert.equal((await reopened.getJob(h.job.job_id))?.approval_continuation_keys?.['7'], 'decision-fixture');
    assert.equal(h.intent()?.completed, true);
  } finally { await h.close(); }
});

test('lost queue reply after durable append is recoverable without another queue admission', async () => {
  const h = await fixture();
  try {
    const queue = h.store.requeueApprovedJobOnce.bind(h.store);
    let lost = false;
    h.store.requeueApprovedJobOnce = async (input) => {
      const result = await queue(input);
      if (!lost) { lost = true; throw new Error('synthetic queue confirmation lost'); }
      return result;
    };
    assert.equal((await h.call()).statusCode, 503);
    await h.store.updateJob(h.job.job_id, { status: 'done' });
    assert.equal((await h.call()).body.rerun, false);
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'done');
  } finally { await h.close(); }
});

test('concurrent original decision callbacks admit original job once', async () => {
  const h = await fixture();
  try {
    const responses = await Promise.all(Array.from({ length: 12 }, () => h.call()));
    assert(responses.every(res => res.statusCode === 200));
    assert.equal(responses.filter(res => res.body.rerun).length, 1);
    assert.equal((await h.store.getJob(h.job.job_id))?.approval_continuation_keys?.['7'], 'decision-fixture');
  } finally { await h.close(); }
});

test('denied decision audit recovers from durable intent but never queues', async () => {
  const h = await fixture();
  try {
    h.faults.audit = true; assert.equal((await h.call('denied')).statusCode, 503);
    h.faults.audit = false;
    assert.equal(await reconcileApprovalContinuationsFor(h.deps), 1);
    assert.equal(h.intent()?.audit_recorded, true);
    assert.equal(h.intent()?.completed, true);
    assert.equal(h.kicks(), 0);
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'done');
  } finally { await h.close(); }
});

test('in-flight original job defers continuation until terminal, used approval does not rerun', async () => {
  const h = await fixture('running');
  try {
    const first = await h.call();
    assert.equal(first.body.continuation_pending, true);
    assert.equal(h.intent()?.completed, false);
    await h.store.updateJob(h.job.job_id, { status: 'done' });
    h.approval.used_at = new Date().toISOString();
    assert.equal(await reconcileApprovalContinuationsFor(h.deps), 1);
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'done');
    assert.equal(h.kicks(), 0);
  } finally { await h.close(); }
});

test('in-flight unconsumed approval gets exactly one later terminal continuation', async () => {
  const h = await fixture('running');
  try {
    assert.equal((await h.call()).body.continuation_pending, true);
    assert.equal(await reconcileApprovalContinuationsFor(h.deps), 0);
    await h.store.updateJob(h.job.job_id, { status: 'done' });
    assert.equal(await reconcileApprovalContinuationsFor(h.deps), 1);
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'queued');
  } finally { await h.close(); }
});

test('console original approval is retryable after queue failure, conflicting reversal remains rejected', async () => {
  const h = await fixture();
  try {
    h.faults.queue = true; assert.equal((await h.consoleCall()).statusCode, 503);
    h.faults.queue = false;
    const retry = await h.consoleCall();
    assert.equal(retry.statusCode, 200); assert.equal(retry.body.idempotent, true); assert.equal(retry.body.rerun, true);
    assert.equal((await h.consoleCall('deny')).statusCode, 409);
    assert.equal((await h.consoleCall()).body.rerun, false);
  } finally { await h.close(); }
});

test('Core-owned queue markers survive ordinary stale metadata and marker replacement patches', async () => {
  const h = await fixture();
  try {
    await h.call();
    await h.store.updateJob(h.job.job_id, { status: 'done', metadata: {}, approval_continuation_keys: {} });
    assert.equal((await h.store.getJob(h.job.job_id))?.approval_continuation_keys?.['7'], 'decision-fixture');
    assert.equal(await h.store.requeueApprovedJobOnce({ job_id: h.job.job_id, request_id: h.job.request_id, approval_id: 7, decision_key: 'decision-fixture' }), 'already_queued');
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'done');
  } finally { await h.close(); }
});

test('closing stops new recovery passes; pass is single flight and no detached timer is created', async () => {
  const h = await fixture();
  try {
    h.faults.audit = true; await h.call(); h.faults.audit = false;
    const closing: ApprovalContinuationDeps = { ...h.deps, isClosing: () => true };
    assert.equal(await reconcileApprovalContinuationsFor(closing), 0);
    assert.equal(h.intent()?.completed, false);
    const original = h.ledger.pendingContinuations!;
    let calls = 0;
    h.ledger.pendingContinuations = async (limit) => { calls++; await Promise.resolve(); return original(limit); };
    const results = await Promise.all([reconcileApprovalContinuationsFor(h.deps), reconcileApprovalContinuationsFor(h.deps)]);
    assert.deepEqual(results, [1, 1]); assert.equal(calls, 1);
  } finally { await h.close(); }
});

test('manual Agent continuation preserves original invocation without Core inference dispatch', async () => {
  const h = await fixture('done', true);
  try {
    h.faults.audit = true; await h.call(); h.faults.audit = false;
    assert.equal(h.intent()!.mode, 'manual');
    await continueApprovalDecisionFor(h.deps, 7);
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'done');
    assert.equal(h.kicks(), 0);
  } finally { await h.close(); }
});

test('console approval responses explain manual continuation and never offer a model rerun for Agent jobs', async () => {
  const h = await fixture('done', true);
  try {
    const listed = await h.consoleRead('/admin/api/tool-approvals?status=all');
    assert.equal(listed.body[0].continuation_mode, 'manual');
    assert.equal(listed.body[0].continuation_pending, false);
    const decision = await h.consoleCall();
    assert.equal(decision.body.continuation_mode, 'manual');
    assert.equal(decision.body.rerun, false);
    assert.equal(decision.body.continuation_pending, false);
    const { consoleExecution } = await import('../routes/admin-runtime-ux');
    assert.deepEqual(consoleExecution((await h.store.getJob(h.job.job_id))!), { kind: 'agent_tool', rerun: { available: false, reason: 'original_client' } });
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'done');
    assert.equal(h.kicks(), 0);
  } finally { await h.close(); }
});

test('console lists persisted decisions as pending recovery after a queue failure and then queued after recovery', async () => {
  const h = await fixture();
  try {
    h.faults.queue = true;
    const failure = await h.consoleCall();
    assert.equal(failure.statusCode, 503);
    assert.equal(failure.body.decision_recorded, true);
    assert.equal(failure.body.continuation_mode, 'rerun');
    const pending = (await h.consoleRead('/admin/api/tool-approvals?status=all')).body[0];
    assert.equal(pending.status, 'approved');
    assert.equal(pending.continuation_pending, true);
    assert.equal(pending.job_status, 'done');
    h.faults.queue = false;
    await reconcileApprovalContinuationsFor(h.deps);
    const queued = (await h.consoleRead('/admin/api/tool-approvals?status=all')).body[0];
    assert.equal(queued.continuation_pending, false);
    assert.equal(queued.job_status, 'queued');
  } finally { await h.close(); }
});

test('missing state continuation port blocks a new decision rather than silently falling back', async () => {
  const h = await fixture();
  try {
    h.deps.stateStore = { ...h.store, requeueApprovedJobOnce: undefined, getJob: h.store.getJob.bind(h.store) } as any;
    const response = await h.call();
    assert.equal(response.statusCode, 503);
    assert.equal(h.approval.status, 'pending');
  } finally { await h.close(); }
});

test('approval consumed between helper observation and atomic JSONL queue admission is not rerun', async () => {
  const h = await fixture();
  try {
    const queue = h.store.requeueApprovedJobOnce.bind(h.store);
    h.store.requeueApprovedJobOnce = async (input) => {
      h.approval.used_at = new Date().toISOString();
      return await queue(input);
    };
    const result = await h.call();
    assert.equal(result.statusCode, 200); assert.equal(result.body.rerun, false);
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'done');
    assert.equal((await h.store.getJob(h.job.job_id))?.approval_continuation_keys, undefined);
    assert.equal(h.intent()?.completed, true);
  } finally { await h.close(); }
});

test('fair keyset pass reaches the 26th continuation after 25 unresolved records and wraps at the end', async () => {
  const h = await fixture();
  try {
    h.approval.id = 26;
    h.faults.audit = true; await h.call(); h.faults.audit = false;
    const rows = Array.from({ length: 26 }, (_, index) => ({ approval_id: index + 1,
      intent_json: { ...h.intent()!, approval_id: index + 1 }, audit_recorded_at: null, completed_at: null }));
    const query = async (_sql: string, params: number[]) => [rows.filter(row => row.approval_id > (params[0] ?? 0)
      && !(row.approval_id === 26 && h.intent()?.completed)).slice(0, 25)];
    const paged = new ApprovalLedger(() => ({ query }));
    h.ledger.pendingContinuations = paged.pendingContinuations.bind(paged);
    const getApproval = h.ledger.get;
    h.ledger.get = async (id) => id === 26 ? getApproval(id) : null;
    const getIntent = h.ledger.getContinuation!;
    h.ledger.getContinuation = async (id) => id === 26 ? getIntent(id) : { ...h.intent()!, approval_id: id };
    assert.equal(await reconcileApprovalContinuationsFor(h.deps), 0);
    assert.equal(h.intent()?.completed, false);
    assert.equal(await reconcileApprovalContinuationsFor(h.deps), 1);
    assert.equal(h.intent()?.completed, true);
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'queued');
    assert.equal((await paged.pendingContinuations()).length, 25);
    const reopened = new ApprovalLedger(() => ({ query }));
    const first = (await reopened.pendingContinuations())[0];
    assert.ok(first); assert.equal(first.approval_id, 1);
  } finally { await h.close(); }
});
