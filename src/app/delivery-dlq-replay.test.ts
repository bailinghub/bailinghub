import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '../core/contracts/types';
import type { DeliveryDlqRecord } from '../core/contracts/delivery-replay';
import type { DeliveryDlqLedgerContract } from '../infrastructure/config/configstore';
import { JsonlStore } from '../infrastructure/state/state-jsonl';
import { classifyDeliveryDlq, replayExecutorDeliveryDlq } from './delivery-dlq-replay';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'notification-dlq-test-'));
  const store = new JsonlStore(join(dir, 'jobs.jsonl')); await store.init();
  const job: Job = { job_id: 'notification-child', request_id: 'deliver-business-parent', status: 'error',
    target: 'sms-notify', source: 'delivery', profile: 'delivery', project: '', input_preview: 'fixture',
    input: 'fixture content', metadata: { to: 'fixture-recipient', parent_job_id: 'business-parent' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  await store.createJob(job);
  const row: DeliveryDlqRecord = { id: 1, parent_job_id: job.job_id, channel: job.target!, recipient: 'fixture-recipient', content: job.input!, resolved: false };
  let failResolve = false;
  const ledger = { get: async () => ({ ...row }), ensureExecutorReplay: async () => {
    const created = !row.executor_replay_key;
    row.delivery_kind = 'executor_target'; row.notification_job_id = job.job_id; row.executor_replay_key = 'delivery-dlq:1';
    return { created, key: row.executor_replay_key };
  }, resolve: async () => { if (failResolve) { failResolve = false; throw new Error('synthetic resolve loss'); } row.resolved = true; } } as unknown as DeliveryDlqLedgerContract;
  return { store, job, row, ledger, failResolve: () => { failResolve = true; }, close: () => rm(dir, { recursive: true, force: true }) };
}

test('executor DLQ replay admits one original notification child under concurrent requests', async () => {
  const h = await fixture();
  try {
    assert.equal(await classifyDeliveryDlq(h.row, h.store), 'executor_target');
    const replies = await Promise.all(Array.from({ length: 8 }, () => replayExecutorDeliveryDlq({ ...h.row }, h.ledger, h.store)));
    assert.equal(replies.filter(x => x.queued).length, 1);
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'queued');
    assert.equal(await h.store.getJob('business-parent'), null);
    assert.equal((await h.store.getJob(h.job.job_id))?.delivery_replay_keys?.['1'], 'delivery-dlq:1');
  } finally { await h.close(); }
});

test('lost resolve acknowledgement and completed child preserve the permanent replay marker', async () => {
  const h = await fixture();
  try {
    h.failResolve();
    await assert.rejects(replayExecutorDeliveryDlq({ ...h.row }, h.ledger, h.store), /resolve loss/);
    await h.store.updateJob(h.job.job_id, { status: 'done', delivery_replay_keys: {} });
    const restarted = new JsonlStore((h.store as any).path); await restarted.init();
    const reply = await replayExecutorDeliveryDlq({ ...h.row }, h.ledger, restarted);
    assert.deepEqual(reply, { queued: false, duplicate: true });
    assert.equal((await restarted.getJob(h.job.job_id))?.status, 'done');
    assert.equal(h.row.resolved, true);
  } finally { await h.close(); }
});

test('native business-parent DLQ remains native; executor wrong parent or payload cannot replay', async () => {
  const h = await fixture();
  try {
    const parent = { ...h.job, job_id: 'business-parent', request_id: 'business', source: 'business', target: 'llm' };
    await h.store.createJob(parent);
    assert.equal(await classifyDeliveryDlq({ ...h.row, parent_job_id: parent.job_id, channel: 'wecom-main' }, h.store), 'native_channel');
    assert.equal(await classifyDeliveryDlq({ ...h.row, parent_job_id: parent.job_id, channel: 'native-notify' }, h.store), 'native_channel');
    await assert.rejects(classifyDeliveryDlq({ ...h.row, delivery_kind: 'executor_target', parent_job_id: parent.job_id }, h.store), /binding_conflict/);
    await assert.rejects(replayExecutorDeliveryDlq({ ...h.row, content: 'changed' }, h.ledger, h.store), /binding_conflict/);
    await assert.rejects(replayExecutorDeliveryDlq({ ...h.row, recipient: 'different' }, h.ledger, h.store), /binding_conflict/);
    assert.equal((await h.store.getJob(h.job.job_id))?.status, 'error');
  } finally { await h.close(); }
});

test('old extension ports fail closed only for executor replay; native stays compatible', async () => {
  const h = await fixture();
  try {
    await assert.rejects(replayExecutorDeliveryDlq(h.row, { get: h.ledger.get } as DeliveryDlqLedgerContract, h.store), /replay_unavailable/);
    assert.equal(await classifyDeliveryDlq({ id: 9, channel: 'native', recipient: 'r', content: 'c', resolved: false }, h.store), 'native_channel');
  } finally { await h.close(); }
});
