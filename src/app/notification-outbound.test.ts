import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../core/config/config';
import type { Job } from '../core/contracts/types';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { notificationBackgroundWorkFor } from '../core/runtime/notification-background-work';
import { finishJob } from '../core/runtime/finish-runtime';
import { approvalDepsForStores } from './tool-approvals';
import { spawnDeliveryJobFor } from './delivery';
import { outboundRuntimeDepsFor, sendAlertWithDeps } from './outbound';

const cfg = { server: { token: 'synthetic-only' }, brand: { name: 'Synthetic' }, alerts: null } as AppConfig;
const now = () => new Date().toISOString();
const job: Job = { job_id: 'fixture', request_id: 'fixture', status: 'done', source: 'test', profile: 'fixture', project: '',
  input_preview: '', created_at: now(), updated_at: now(), result: { text: 'synthetic' }, metadata: {} };

for (const kind of ['delivery', 'approval', 'alert'] as const) test(`notification tracker retains innermost detached ${kind} webhook`, async () => {
  const originalFetch = globalThis.fetch;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const startedGate = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = async () => { started(); await gate; return new Response('', { status: 200 }); };
  const state = { appendAudit: async () => {} } as unknown as RuntimeStateStore;
  const work = notificationBackgroundWorkFor(state);
  try {
    if (kind === 'delivery') await spawnDeliveryJobFor({ cfg, configStore: null, stateStore: state, now, sleep: async () => {} },
      { ...job, dispatch: { delivery: { type: 'webhook', url: 'https://synthetic.invalid/delivery' } } });
    if (kind === 'approval') {
      const approvals = approvalDepsForStores({ approvals: {} } as ConfigStoreContract, state, job, { name: 'fixture' } as any,
        { approval: { type: 'business_webhook', url: 'https://synthetic.invalid/approval' } }, { provider: 'fixture', allow: ['*'] }, cfg, now, async () => {});
      await approvals!.notify(1, { tool: 'fixture', scope: 'fixture', risk: 'high', policy: 'always', reason: 'fixture', method: 'POST', path: '/', args_hash: 'fixture', args_json: '{}' });
    }
    if (kind === 'alert') await sendAlertWithDeps(outboundRuntimeDepsFor({ cfg: { ...cfg, alerts: { type: 'webhook', url: 'https://synthetic.invalid/alert', cooldown_min: 0 } },
      configStore: null, stateStore: state, now, sleep: async () => {} }), 'fixture', 'synthetic');
    await startedGate;
    work.beginDrain(); assert.equal(await work.drain(1), false);
    release(); assert.equal(await work.drain(100), true);
  } finally { release(); await work.drain(100); globalThis.fetch = originalFetch; }
});

test('finish tracks a DLQ insertion through drain and reports a failed insert', async () => {
  const state = { updateJob: async (_id: string, patch: Partial<Job>) => ({ ...job, ...patch }), appendAudit: async () => {} };
  const work = notificationBackgroundWorkFor(state);
  const failures: string[] = []; work.setFailureReporter(kind => failures.push(kind));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await finishJob({ ...job, source: 'delivery', target: 'sms-notify' }, { status: 'error' }, { store: state, now,
    fireCallback: async () => {}, spawnDeliveryJob: async () => {}, sendAlert: async () => {},
    deliveryDlq: { async record() { await gate; throw new Error('private SQL error'); } } });
  assert.equal(await work.drain(1), false); release(); assert.equal(await work.drain(100), true);
  assert.ok(failures.includes('delivery-dlq'));
});
