import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '../app/auth';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { NotificationEvent, NotificationOutboxRepository } from '../core/contracts/notification-outbox';
import { handleAdminNotificationsFor } from './admin-notifications';

const path = '/admin/api/notification-outbox';
const admin = { kind: 'admin', via: 'session', username: 'operator', role: 'admin' } as Principal;
const viewer = { ...admin, role: 'viewer' } as Principal;
function fixture() {
  const event = { event_id: 'event:synthetic', kind: 'callback', job_id: 'job', request_id: 'request', status: 'uncertain',
    attempts: 2, cycle_attempts: 2, recovery: 'retry', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), available_at: new Date().toISOString(),
    payload: { job: { input: 'private content', callback_url: 'https://example.invalid/?token=secret' } }, lease_token: 'private-lease',
    last_error: 'SELECT private SQL password' } as NotificationEvent;
  const calls: string[] = [];
  const outbox = {
    async list(options: Parameters<NotificationOutboxRepository['list']>[0]) { calls.push(`list:${options?.kinds?.[0]}:${options?.offset}`); return [event]; },
    async snapshot(options: Parameters<NotificationOutboxRepository['snapshot']>[0]) { calls.push(`snapshot:${options?.kinds?.[0]}`); return { counts: { pending: 0, processing: 0, completed: 0, skipped: 0, failed: 0, uncertain: 1 }, oldestPendingAgeSeconds: 0, expiredLeases: 0 }; },
    async get() { return event; },
    async retry(_id: string, options: Parameters<NotificationOutboxRepository['retry']>[1]) { calls.push('retry'); if (options?.expectedStatus !== event.status) return false; event.status = 'pending'; return true; },
  } as unknown as NotificationOutboxRepository;
  const deps = { stateStore: { notificationOutbox: outbox, async completeJobWithNotifications() { throw new Error('must not rerun business'); }, async appendAudit() { calls.push('audit'); } } as unknown as RuntimeStateStore,
    configStore: null as ConfigStoreContract | null, now: () => new Date().toISOString() };
  return { deps, calls, event, outbox };
}
async function request(deps: ReturnType<typeof fixture>['deps'], method: string, url: string, principal = admin, payload?: unknown) {
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]) as IncomingMessage;
  req.url = url; req.headers = {};
  const result = { status: 0, body: '' };
  const res = { writeHead(status: number) { result.status = status; }, setHeader() {}, end(body: string) { result.body = String(body); } } as unknown as ServerResponse;
  await handleAdminNotificationsFor(deps, method, url.split('?')[0]!, req, res, principal);
  return { ...result, json: JSON.parse(result.body) };
}

test('notification summaries omit payload, destination and lease; state/config are partitioned by kind', async () => {
  const f = fixture();
  const result = await request(f.deps, 'GET', `${path}?kind=callback&offset=20`, viewer);
  assert.equal(result.status, 200);
  assert.equal(result.json.items[0].last_error, 'notification_delivery_failed');
  assert.doesNotMatch(result.body, /private|token=secret|lease_token|payload/);
  assert.deepEqual(f.calls, ['list:callback:20', 'snapshot:callback']);
  f.event.last_error = 'PRIVATE_TOKEN_WITHOUT_SPACES';
  assert.doesNotMatch((await request(f.deps, 'GET', `${path}?kind=callback`, viewer)).body, /PRIVATE_TOKEN/);
  assert.equal((await request(f.deps, 'GET', `${path}?kind=approval-notification`, viewer)).status, 503);
  f.deps.configStore = { notificationOutbox: f.outbox, approvals: { createWithNotification: async () => 1 } } as unknown as ConfigStoreContract;
  await request(f.deps, 'GET', `${path}?kind=approval-notification`, viewer);
  assert.equal(f.calls.at(-1), 'snapshot:approval-notification');
});

test('viewer cannot retry, and uncertain retry requires explicit acknowledgment without touching the original job', async () => {
  const f = fixture(); const url = `${path}/event%3Asynthetic/retry`;
  const body = { kind: 'callback', expected_status: 'uncertain' };
  assert.equal((await request(f.deps, 'POST', url, viewer, { ...body, allow_uncertain: true })).status, 403);
  assert.equal((await request(f.deps, 'POST', url, admin, body)).status, 409);
  assert.deepEqual(f.calls, []);
  assert.equal((await request(f.deps, 'POST', url, admin, { ...body, allow_uncertain: true })).status, 200);
  assert.deepEqual(f.calls, ['retry', 'audit']);
  assert.equal(f.event.event_id, 'event:synthetic');
  assert.equal(f.event.status, 'pending');
  assert.equal((await request(f.deps, 'POST', url, admin, { ...body, allow_uncertain: true })).status, 409);
});

test('notification retry rejects mismatched kind, completed state and invalid input', async () => {
  const f = fixture();
  assert.equal((await request(f.deps, 'POST', `${path}/event%3Asynthetic/retry`, admin, null)).status, 400);
  assert.equal((await request(f.deps, 'POST', `${path}/event%3Asynthetic/retry`, admin, { kind: 'delivery', expected_status: 'failed' })).status, 404);
  assert.equal((await request(f.deps, 'POST', `${path}/event%3Asynthetic/retry`, admin, { kind: 'callback', expected_status: 'completed' })).status, 400);
  assert.equal((await request(f.deps, 'GET', `${path}?offset=-1`)).status, 400);
  assert.equal((await request(f.deps, 'GET', `${path}?status=arbitrary`)).status, 400);
  assert.deepEqual(f.calls, []);
});
