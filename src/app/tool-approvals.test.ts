import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from '../core/contracts/types';
import type { AppConfig } from '../core/config/config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ApprovalIntentSnap } from '../core/contracts/tools';
import { argsHash, approvalNotificationSnapshot } from '../core/contracts/tools';
import { approvalDepsForStores, approvedNoteForJobFor, notifyApprovalPayloadFor } from './tool-approvals';
import { defaultTargetRegistry } from '../core/targets/registry';

const now = () => new Date().toISOString();
const cfg = { server: { token: 'synthetic-only' }, brand: { name: 'Synthetic' }, alerts: null } as AppConfig;
const state = { appendAudit: async () => {} } as unknown as RuntimeStateStore;
const job = (): Job => ({ job_id: 'synthetic-job', request_id: 'synthetic-request', status: 'running', source: 'test',
  profile: 'test', project: '', input_preview: '', created_at: now(), updated_at: now(),
  metadata: { subject: 'synthetic-user', agent_frozen_arguments: 'private-encrypted-recovery-marker' } });
function snapshot(large = true): ApprovalIntentSnap {
  const args = { source: { html: large ? `中😀"\\${'x'.repeat(200_000)}DO_NOT_COPY_FULL_DESIGN_END` : 'small', css: '' } };
  return { tool: 'synthetic_save', scope: 'synthetic.write', risk: 'high', policy: 'always', reason: 'synthetic',
    method: 'POST', path: '/synthetic', args_json: JSON.stringify(args), args_hash: argsHash(args) };
}

test('atomic approval retains full execution arguments but persists only a bounded notification projection', async () => {
  const original = job(), snap = snapshot(); let saved: any, draft: any;
  const config = { approvals: { createWithNotification: async (approval: unknown, notification: unknown) => {
    saved = structuredClone(approval); draft = structuredClone(notification); return 7;
  } } } as unknown as ConfigStoreContract;
  const approvals = approvalDepsForStores(config, state, original, { name: 'synthetic' } as any, {},
    { provider: 'synthetic', allow: ['*'], subject_field: 'subject' }, cfg, now, async () => {});
  assert.equal(await approvals!.create(snap), 7);
  assert.equal(saved.args_json, snap.args_json); assert.equal(argsHash(JSON.parse(saved.args_json)), snap.args_hash);
  assert.deepEqual(saved.intent.args, JSON.parse(snap.args_json));
  assert.equal(saved.intent.metadata.subject, 'synthetic-user');
  assert.equal(saved.intent.metadata.agent_frozen_arguments, undefined);
  assert.equal(draft.job.metadata.agent_frozen_arguments, undefined);
  assert.equal(original.metadata.agent_frozen_arguments, 'private-encrypted-recovery-marker');
  assert.equal(draft.snap.args_truncated, true); assert.equal(draft.snap.args_hash, snap.args_hash);
  assert.equal(draft.snap.args_bytes, Buffer.byteLength(snap.args_json, 'utf8'));
  assert.equal(JSON.parse(draft.snap.args_json).truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(draft), 'utf8') < 5000);
  assert.equal(JSON.stringify(draft).includes('DO_NOT_COPY_FULL_DESIGN_END'), false);
  assert.equal(JSON.stringify(draft).includes('private-encrypted-recovery-marker'), false);
});

test('small notifications preserve original JSON object and large previews remain bounded and idempotent', () => {
  const small = snapshot(false);
  assert.equal(approvalNotificationSnapshot(small).args_json, small.args_json);
  assert.equal(approvalNotificationSnapshot(small).args_truncated, undefined);
  const large = snapshot(); large.summary = '中'.repeat(1000);
  const preview = approvalNotificationSnapshot(large);
  assert.equal(preview.args_bytes, Buffer.byteLength(large.args_json, 'utf8'));
  assert.ok(Buffer.byteLength(preview.args_json, 'utf8') <= 1000);
  assert.ok(Buffer.byteLength(preview.summary!, 'utf8') <= 512);
  assert.deepEqual(approvalNotificationSnapshot(preview), preview);
});

test('historical full notification drafts are projected again before any signed webhook dispatch', async () => {
  const original = job(), snap = snapshot(); let sent: any;
  const config = { approvals: { get: async () => ({ job_id: original.job_id, request_id: original.request_id, status: 'pending' }) } } as unknown as ConfigStoreContract;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { sent = JSON.parse(String(init?.body)); return new Response('', { status: 200 }); };
  try {
    const out = await notifyApprovalPayloadFor(config, state, { approval_id: 7, job: original, snap,
      provider_name: 'synthetic', subject: 'synthetic-user', destination: { type: 'business_webhook', url: 'https://synthetic.invalid/approval' } },
    cfg, now, async () => {}, defaultTargetRegistry, 'approval:7');
    assert.equal(out.status, 'completed'); assert.equal(sent.args_truncated, true);
    assert.equal(sent.args_hash, snap.args_hash); assert.equal(sent.intent.args_hash, snap.args_hash);
    assert.equal(sent.args_bytes, Buffer.byteLength(snap.args_json, 'utf8'));
    assert.equal(sent.metadata.agent_frozen_arguments, undefined);
    assert.equal(sent.intent.metadata.agent_frozen_arguments, undefined);
    assert.equal(JSON.stringify(sent).includes('DO_NOT_COPY_FULL_DESIGN_END'), false);
    assert.equal(JSON.stringify(sent).includes('private-encrypted-recovery-marker'), false);
    assert.ok(Buffer.byteLength(JSON.stringify(sent), 'utf8') < 7000);
  } finally { globalThis.fetch = originalFetch; }
});

test('legacy approved note retains complete approved parameters rather than silently cropping the action', async () => {
  const snap = snapshot();
  const config = { approvals: { approvedUnusedForJob: async () => [{ id: 7, tool: snap.tool, args_json: snap.args_json }] } } as unknown as ConfigStoreContract;
  const note = await approvedNoteForJobFor(config, 'synthetic-job');
  assert.ok(note?.includes(snap.args_json)); assert.ok(note?.includes('DO_NOT_COPY_FULL_DESIGN_END'));
});
