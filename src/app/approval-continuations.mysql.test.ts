import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPool } from 'mysql2/promise';
import type { Job } from '../core/contracts/types';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { ApprovalLedger } from '../infrastructure/config/config-approval-ledger';
import { MysqlStore } from '../infrastructure/state/state-mysql';
import { migrateBailingHubCoreSchema } from '../infrastructure/schema/core-schema-migrator';
import { continueApprovalDecisionFor, reconcileApprovalContinuationsFor, type ApprovalContinuationDeps } from './approval-continuations';

const enabled = process.env.BAILING_APPROVAL_CONTINUATION_TEST_MYSQL === '1';

async function fixture() {
  const database = `approval_acceptance_${randomUUID().replaceAll('-', '')}`;
  const mysql = { host: '127.0.0.1', port: 16307, user: 'root', password: '', database, connectionLimit: 8 };
  const admin = createPool({ ...mysql, database: undefined });
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  const pool = createPool({ ...mysql, timezone: 'Z' });
  try {
    await migrateBailingHubCoreSchema({ mysql, logger: { log() {}, warn() {} } });
    const ledger = new ApprovalLedger(() => pool);
    const owner = { get: async () => pool, close: async () => {} };
    const store = new MysqlStore(mysql, owner); await store.init();
    const now = () => new Date().toISOString();
    const job: Job = { job_id: randomUUID(), request_id: `fixture-${randomUUID()}`, status: 'done', target: 'llm',
      profile: 'synthetic', project: '', source: 'synthetic', input_preview: '', metadata: {}, created_at: now(), updated_at: now() };
    await store.createJob(job);
    const approvalId = await ledger.create({ job_id: job.job_id, request_id: job.request_id, provider: 'synthetic', tool: 'refund_create',
      scope: 'refund.create', risk: 'high', args_hash: 'a'.repeat(64), args_json: '{"synthetic":true}' });
    const decisionId = `decision-${randomUUID()}`;
    let kicks = 0;
    const deps: ApprovalContinuationDeps = { configStore: { approvals: ledger } as unknown as ConfigStoreContract,
      stateStore: store, now, engineRuntime: { kickInhubScheduler: () => { kicks++; } } };
    const decide = () => ledger.decideWithContinuation(approvalId, 'approved', 'synthetic-operator', {
      decision_id: decisionId, source: 'external', auth: 'fixture', mode: 'rerun' });
    return { mysql, pool, store, ledger, deps, job, approvalId, decisionId, decide, kicks: () => kicks,
      close: async () => { await pool.end(); await admin.query(`DROP DATABASE \`${database}\``); await admin.end(); } };
  } catch (error) {
    await pool.end(); await admin.query(`DROP DATABASE \`${database}\``); await admin.end(); throw error;
  }
}

for (const stage of ['after-decision', 'after-queue'] as const) test(`MySQL original approval survives actual SIGKILL ${stage}`, { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const child = fork(fileURLToPath(new URL('../test-support/approval-continuation-crash-child.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('synthetic crash worker timeout')); }, 10_000);
      child.once('error', reject);
      child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    });
    const checkpoint = new Promise<any>((resolve, reject) => {
      child.once('message', (message: any) => message.error ? reject(new Error(message.error)) : resolve(message));
      child.once('exit', (code, signal) => { if (code !== null && code !== 0 && signal !== 'SIGKILL') reject(new Error('synthetic crash worker exited early')); });
    });
    child.send({ mysql: h.mysql, approvalId: h.approvalId, jobId: h.job.job_id, requestId: h.job.request_id, stage, decisionId: h.decisionId });
    const evidence = await checkpoint;
    assert.equal(evidence.stage, stage); assert.notEqual(evidence.pid, process.pid);
    assert.equal((await exited).signal, 'SIGKILL');
    assert.equal((await h.ledger.get(h.approvalId))?.status, 'approved');
    assert.equal((await h.ledger.getContinuation(h.approvalId))?.completed, false);
    if (stage === 'after-queue') await h.store.updateJob(h.job.job_id, { status: 'done', result: { text: 'synthetic confirmed' }, metadata: {} });
    const restarted = new MysqlStore(h.mysql, { get: async () => h.pool, close: async () => {} }); await restarted.init();
    h.deps.stateStore = restarted;
    assert.equal(await reconcileApprovalContinuationsFor(h.deps), 1);
    const recovered = await restarted.getJob(h.job.job_id);
    assert.equal(recovered?.status, stage === 'after-decision' ? 'queued' : 'done');
    assert.equal(recovered?.approval_continuation_keys?.[String(h.approvalId)], h.decisionId);
    assert.equal(await reconcileApprovalContinuationsFor(h.deps), 0);
  } finally { await h.close(); }
});

test('MySQL decision COMMIT acknowledgement lost retains decision and intent in the same transaction', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const faulty = new ApprovalLedger(() => ({ getConnection: async () => {
      const connection = await h.pool.getConnection();
      const commit = connection.commit.bind(connection);
      connection.commit = async () => { connection.commit = commit; await commit(); throw new Error('synthetic decision COMMIT reply lost'); };
      return connection;
    } }));
    await assert.rejects(() => faulty.decideWithContinuation(h.approvalId, 'approved', 'synthetic-operator', {
      decision_id: h.decisionId, source: 'external', auth: 'fixture', mode: 'rerun' }), /COMMIT reply lost/);
    assert.equal((await h.ledger.get(h.approvalId))?.status, 'approved');
    assert.equal((await h.ledger.getContinuation(h.approvalId))?.decision_key, h.decisionId);
    assert.equal(await h.decide(), 'same');
    assert.equal((await continueApprovalDecisionFor(h.deps, h.approvalId)).rerun, true);
  } finally { await h.close(); }
});

test('MySQL concurrent continuation and completed new run have one durable admission', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const decisions = await Promise.all(Array.from({ length: 8 }, () => h.decide()));
    assert.equal(decisions.filter(item => item === 'decided').length, 1);
    assert.equal(decisions.filter(item => item === 'same').length, 7);
    const results = await Promise.all(Array.from({ length: 8 }, () => continueApprovalDecisionFor(h.deps, h.approvalId)));
    assert.equal(results.filter(item => item.rerun).length, 1);
    const intent = await h.ledger.getContinuation(h.approvalId);
    assert.equal(intent?.completed, true);
    await h.store.updateJob(h.job.job_id, { status: 'done', metadata: {}, approval_continuation_keys: {} });
    assert.equal(await h.store.requeueApprovedJobOnce({ job_id: h.job.job_id, request_id: h.job.request_id,
      approval_id: h.approvalId, decision_key: h.decisionId }), 'already_queued');
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'done');
  } finally { await h.close(); }
});

test('MySQL missing continuation table rolls back approval decision rather than orphaning it', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    await h.pool.query('DROP TABLE bz_approval_continuations');
    await assert.rejects(h.decide);
    assert.equal((await h.ledger.get(h.approvalId))?.status, 'pending');
  } finally { await h.close(); }
});

test('MySQL atomic admission rechecks approval consumed after the helper observation', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    await h.decide();
    const queue = h.store.requeueApprovedJobOnce.bind(h.store);
    h.store.requeueApprovedJobOnce = async (input) => {
      assert.equal(await h.ledger.use(h.approvalId), true);
      return await queue(input);
    };
    const result = await continueApprovalDecisionFor(h.deps, h.approvalId);
    assert.equal(result.rerun, false);
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'done');
    assert.equal((await h.store.getJob(h.job.job_id))?.approval_continuation_keys, undefined);
    assert.equal((await h.ledger.getContinuation(h.approvalId))?.completed, true);
    assert.equal(h.kicks(), 0);
  } finally { await h.close(); }
});
