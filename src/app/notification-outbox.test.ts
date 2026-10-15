import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { JsonlStore } from '../infrastructure/state/state-jsonl';
import { JsonlNotificationOutbox } from '../infrastructure/state/notification-outbox-jsonl';
import { newNotification } from '../core/state/notification-outbox';
import type { Job } from '../core/contracts/types';
import type { AppConfig } from '../core/config/config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { ApprovalNotificationPayload } from '../core/contracts/notification-outbox';
import { reconcileNotificationOutboxFor, type NotificationOutboxDeps } from './notification-outbox';
import { createNotificationChildOnce } from './delivery';
import { defaultTargetRegistry } from '../core/targets/registry';
import { notifyApprovalPayloadFor, approvalDepsForStores } from './tool-approvals';
import { notificationBackgroundWorkFor } from '../core/runtime/notification-background-work';

const cfg = { server: { token: 'synthetic-notification-secret' }, brand: { name: 'Synthetic' }, alerts: null } as AppConfig;
const now = () => new Date().toISOString();
const job = (extra: Partial<Job> = {}): Job => ({ job_id: 'synthetic-parent', request_id: 'synthetic-request', status: 'running',
  source: 'test', target: 'llm', profile: 'test', project: '', input_preview: '', metadata: {}, created_at: now(), updated_at: now(), ...extra });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'notification-outbox-'));
  const path = join(dir, 'state.jsonl'); const state = new JsonlStore(path); await state.init();
  return { dir, path, state, deps: { cfg, configStore: null, stateStore: state, now, sleep: async () => {} } as NotificationOutboxDeps };
}
async function receiver(handle: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer(async (req, res) => { let body = ''; for await (const part of req) body += part; handle(req, res, body); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/notification`;
  return { url, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('cold restart sends frozen terminal snapshot; signature covers stable ID and retry preserves it', async () => {
  const f = await fixture(); const received: Array<{ id: string; body: any }> = []; let status = 503;
  const http = await receiver((req, res, raw) => {
    const parsed = JSON.parse(raw); const id = String(req.headers['x-bailing-event-id']);
    assert.equal(parsed.notification_event_id, id);
    assert.equal(req.headers['x-bailing-signature'], `sha256=${createHmac('sha256', cfg.server.token).update(`${req.headers['x-bailing-timestamp']}.${raw}`).digest('hex')}`);
    received.push({ id, body: parsed }); res.writeHead(status).end();
  });
  try {
    const original = job({ callback_url: http.url }); await f.state.createJob(original);
    await f.state.completeJobWithNotifications(original, { status: 'done', result: { text: 'frozen-result' } });
    const restarted = new JsonlStore(f.path); await restarted.init();
    const deps = { ...f.deps, stateStore: restarted };
    await reconcileNotificationOutboxFor(deps);
    const event = (await restarted.notificationOutbox.list())[0]!;
    assert.equal(event.status, 'pending'); assert.equal(event.cycle_attempts, 1);
    await restarted.updateJob(original.job_id, { result: { text: 'later mutable value' } });
    status = 200;
    await reconcileNotificationOutboxFor({ ...deps, now: () => new Date(Date.now() + 3600_000).toISOString() });
    assert.equal((await restarted.notificationOutbox.get(event.event_id))?.status, 'completed');
    assert.equal(received.length, 2); assert.equal(received[0]!.id, received[1]!.id);
    assert.equal(received[1]!.body.result.text, 'frozen-result');
    assert.equal((await restarted.getJob(original.job_id))?.status, 'done');
    await reconcileNotificationOutboxFor(deps); assert.equal(received.length, 2);
  } finally { await http.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('explicit rejection stops; retryable failures stop after six attempts and manual retry resets the cycle', async () => {
  const f = await fixture(); let calls = 0, status = 403;
  const http = await receiver((_req, res) => { calls++; res.writeHead(status).end(); });
  try {
    const original = job({ callback_url: http.url }); await f.state.createJob(original);
    await f.state.completeJobWithNotifications(original, { status: 'done' });
    await reconcileNotificationOutboxFor(f.deps);
    const id = (await f.state.notificationOutbox.list())[0]!.event_id;
    assert.equal((await f.state.notificationOutbox.get(id))?.status, 'failed'); assert.equal(calls, 1);
    await reconcileNotificationOutboxFor(f.deps); assert.equal(calls, 1);
    await f.state.notificationOutbox.retry(id); status = 500;
    for (let attempt = 0; attempt < 6; attempt++) await reconcileNotificationOutboxFor({ ...f.deps, now: () => new Date(Date.now() + (attempt + 1) * 3600_000).toISOString() });
    const failed = await f.state.notificationOutbox.get(id);
    assert.equal(failed?.status, 'failed'); assert.equal(failed?.cycle_attempts, 6); assert.equal(calls, 7);
    await f.state.notificationOutbox.retry(id); status = 200;
    await reconcileNotificationOutboxFor(f.deps);
    assert.equal((await f.state.notificationOutbox.get(id))?.status, 'completed');
    assert.equal((await f.state.notificationOutbox.get(id))?.cycle_attempts, 1);
  } finally { await http.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('SIGKILL after receiver ACK before durable ACK replays only the same notification', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture(); const ids: string[] = [];
  const http = await receiver((req, res) => { ids.push(String(req.headers['x-bailing-event-id'])); res.writeHead(200).end(); });
  try {
    const original = job({ callback_url: http.url }); await f.state.createJob(original);
    await f.state.completeJobWithNotifications(original, { status: 'done', result: { text: 'one business execution' } });
    const script = `import {JsonlStore} from './src/infrastructure/state/state-jsonl.ts'; import {reconcileNotificationOutboxFor} from './src/app/notification-outbox.ts';
      const state = new JsonlStore(${JSON.stringify(f.path)}); await state.init(); state.notificationOutbox.complete = async () => { process.kill(process.pid, 'SIGKILL'); return false; };
      await reconcileNotificationOutboxFor({cfg:${JSON.stringify(cfg)},configStore:null,stateStore:state,now:()=>new Date().toISOString(),sleep:async()=>{}});`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd: process.cwd(), stdio: 'pipe' });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
    const [, signal] = await once(child, 'exit'); assert.equal(signal, 'SIGKILL', stderr);
    const restarted = new JsonlStore(f.path); await restarted.init();
    await reconcileNotificationOutboxFor({ ...f.deps, stateStore: restarted, now: () => new Date(Date.now() + 120_000).toISOString() });
    assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
    assert.equal((await restarted.notificationOutbox.list())[0]?.status, 'completed');
    assert.equal((await restarted.getJob(original.job_id))?.status, 'done');
    assert.equal((await restarted.listJobsByStatus(['queued', 'running'])).length, 0);
  } finally { await http.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('native partial delivery remains uncertain and records one event-bound DLQ without automatic resend', async () => {
  const f = await fixture(); let calls = 0; const dlqs: any[] = [];
  const config = { deliveryDlq: { record: async (record: unknown) => { dlqs.push(record); } } } as unknown as ConfigStoreContract;
  try {
    const original = job({ dispatch: { delivery: { type: 'channel', channel: 'synthetic', to: 'person' } } });
    await f.state.createJob(original); await f.state.completeJobWithNotifications(original, { status: 'done', result: { text: 'notification' } });
    const deps = { ...f.deps, configStore: config, channelSendFor: async () => { calls++; return { ok: false, error: 'partial', mayHaveCommitted: true }; } };
    await reconcileNotificationOutboxFor(deps); await reconcileNotificationOutboxFor(deps);
    const event = (await f.state.notificationOutbox.list())[0]!;
    assert.equal(event.status, 'uncertain'); assert.equal(calls, 1); assert.equal(dlqs.length, 1); assert.equal(dlqs[0].eventId, event.event_id);
    assert.equal(await f.state.notificationOutbox.retry(event.event_id), false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('approval notification uses its frozen destination and skips already decided approval', async () => {
  const f = await fixture(); let calls = 0;
  const http = await receiver((_req, res, body) => { calls++; assert.equal(JSON.parse(body).notification_event_id, 'approval:7'); res.writeHead(200).end(); });
  try {
    let status = 'approved'; const j = job();
    const config = { approvals: { get: async () => ({ job_id: j.job_id, request_id: j.request_id, status }) } } as unknown as ConfigStoreContract;
    const payload: ApprovalNotificationPayload = { approval_id: 7, job: j, provider_name: 'synthetic', subject: 'user', brand_name: 'frozen',
      destination: { type: 'business_webhook', url: http.url }, snap: { tool: 'synthetic', scope: 'test', risk: 'high', policy: 'always', reason: 'test', method: 'POST', path: '/', args_json: '{}', args_hash: 'test' } };
    assert.equal((await notifyApprovalPayloadFor(config, f.state, payload, cfg, now, async () => {}, defaultTargetRegistry, 'approval:7')).status, 'skipped');
    assert.equal(calls, 0); status = 'pending';
    const outbox = new JsonlNotificationOutbox(async work => work(), async () => {});
    outbox.publish([newNotification('approval:7', 'approval-notification', payload, now())]);
    await reconcileNotificationOutboxFor({ ...f.deps, configStore: { ...config, notificationOutbox: outbox } });
    assert.equal(calls, 1); assert.equal((await outbox.get('approval:7'))?.status, 'completed');
  } finally { await http.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('notification child create acknowledgement loss rereads exact binding; conflict never substitutes business work', async () => {
  const f = await fixture();
  try {
    const child = job({ job_id: 'notification-child', request_id: 'approval_9', status: 'queued', source: 'delivery', target: 'test-notify', input: 'frozen', metadata: { parent_job_id: 'business-parent', approval_id: 9 } });
    const create = f.state.createJob.bind(f.state);
    f.state.createJob = async value => { await create(value); throw new Error('commit ACK lost'); };
    assert.equal((await createNotificationChildOnce(f.state, child)).job_id, child.job_id);
    await assert.rejects(createNotificationChildOnce(f.state, { ...child, input: 'different' }), /binding_conflict/);
    assert.equal((await f.state.listJobsByStatus(['queued'])).length, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('approval producer uses the atomic creation port, stores references and never sends before commit', async () => {
  const f = await fixture(); let draft: any;
  try {
    const config = { approvals: { createWithNotification: async (_a: unknown, value: unknown) => { draft = structuredClone(value); return 5; }, create: async () => { throw new Error('legacy create forbidden'); } } } as unknown as ConfigStoreContract;
    const approval = approvalDepsForStores(config, f.state, job(), { name: 'provider', secret: 'must-not-persist' } as any,
      { approval: { type: 'webhook', url: 'https://synthetic.invalid/approval' } }, { provider: 'provider', allow: [] }, cfg, now, async () => {});
    const snap = { tool: 'test', scope: 'test', risk: 'high', policy: 'always', reason: 'test', method: 'POST', path: '/', args_json: '{}', args_hash: 'hash' };
    assert.equal(await approval!.create(snap), 5); await approval!.notify(5, snap);
    assert.equal(draft.provider_name, 'provider'); assert.equal(draft.brand_name, 'Synthetic');
    assert.equal(JSON.stringify(draft).includes('must-not-persist'), false);
    assert.equal(JSON.stringify(draft).includes(cfg.server.token), false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('lost notification lease fences sending and acknowledgement; closing never claims new work', async () => {
  const f = await fixture(); let sent = 0;
  const http = await receiver((_req, res) => { sent++; res.writeHead(200).end(); });
  try {
    const original = job({ callback_url: http.url }); await f.state.createJob(original);
    await f.state.completeJobWithNotifications(original, { status: 'done' });
    await reconcileNotificationOutboxFor({ ...f.deps, isClosing: () => true });
    const pending = (await f.state.notificationOutbox.list())[0]!; assert.equal(pending.status, 'pending'); assert.equal(pending.attempts, 0);
    f.state.notificationOutbox.renew = async () => false;
    await reconcileNotificationOutboxFor(f.deps);
    assert.equal(sent, 0); assert.equal((await f.state.notificationOutbox.get(pending.event_id))?.status, 'processing');
  } finally { await http.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('a replacement worker fences the old send acknowledgement even after HTTP succeeds', async () => {
  const f = await fixture(); let replacementToken = '';
  const http = await receiver((_req, res) => {
    void f.state.notificationOutbox.claim({ owner: 'replacement', kinds: ['callback'], now: new Date(Date.now() + 120_000).toISOString(), leaseMs: 300_000 })
      .then(events => { replacementToken = events[0]!.lease_token!; res.writeHead(200).end(); });
  });
  try {
    const original = job({ callback_url: http.url }); await f.state.createJob(original);
    await f.state.completeJobWithNotifications(original, { status: 'done' });
    await reconcileNotificationOutboxFor(f.deps);
    const current = (await f.state.notificationOutbox.list())[0]!;
    assert.equal(current.status, 'processing'); assert.equal(current.lease_owner, 'replacement'); assert.equal(current.lease_token, replacementToken);
    assert.equal(current.attempts, 2);
  } finally { await http.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('two legitimate terminal transitions get distinct callback IDs and preserve the original notification child', async () => {
  const f = await fixture(); const callbackIds: string[] = [];
  const http = await receiver((req, res) => { callbackIds.push(String(req.headers['x-bailing-event-id'])); res.writeHead(200).end(); });
  try {
    const { TargetRegistry } = await import('../core/targets/registry'); const registry = new TargetRegistry();
    registry.setTargets([{ name: 'synthetic-notify', kind: 'executor', stateless: true, needs_project: false, timeout_ms: 1000, enabled: true }]);
    const original = job({ callback_url: http.url, dispatch: { delivery: { type: 'synthetic', to: 'person' } } });
    await f.state.createJob(original); await f.state.completeJobWithNotifications(original, { status: 'done', result: { text: 'first result' } });
    await reconcileNotificationOutboxFor({ ...f.deps, targetRegistry: registry });
    const firstChild = await f.state.findByRequestId(`deliver_${original.job_id}`); assert.ok(firstChild);
    const next = await f.state.updateJob(original.job_id, { status: 'running', claim_token: 'second-run' }); assert.ok(next);
    await f.state.completeJobWithNotifications(next, { status: 'done', result: { text: 'second result' } });
    await reconcileNotificationOutboxFor({ ...f.deps, targetRegistry: registry });
    assert.equal(callbackIds.length, 2); assert.notEqual(callbackIds[0], callbackIds[1]);
    assert.equal((await f.state.findByRequestId(`deliver_${original.job_id}`))?.job_id, firstChild.job_id);
    const deliveries = await f.state.notificationOutbox.list({ kinds: ['delivery'] });
    assert.equal(deliveries.length, 2); assert.deepEqual(deliveries.map(event => event.status).sort(), ['completed', 'skipped']);
    assert.equal((await f.state.listJobsByStatus(['queued'])).length, 1);
  } finally { await http.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('native delivery completion precedes DLQ resolution and resolution failure cannot replay the message', async () => {
  const f = await fixture(); let sends = 0, resolutions = 0;
  try {
    const original = job({ dispatch: { delivery: { type: 'channel', channel: 'synthetic', to: 'person' } } });
    await f.state.createJob(original); await f.state.completeJobWithNotifications(original, { status: 'done', result: { text: 'notification' } });
    const config = { channels: { get: async () => null }, deliveryDlq: { resolveByEventId: async () => { resolutions++; throw new Error('resolution ACK lost'); } } } as unknown as ConfigStoreContract;
    const deps = { ...f.deps, configStore: config, channelSendFor: async () => { sends++; return { ok: true }; } };
    await reconcileNotificationOutboxFor(deps); await reconcileNotificationOutboxFor(deps);
    assert.equal(sends, 1); assert.equal(resolutions, 1); assert.equal((await f.state.notificationOutbox.list())[0]?.status, 'completed');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('crash recovery cannot bypass the six-attempt cycle limit', async () => {
  const f = await fixture(); let sends = 0;
  const http = await receiver((_req, res) => { sends++; res.writeHead(200).end(); });
  try {
    const event = newNotification('synthetic-crash-exhausted', 'callback', { job: job({ status: 'done', callback_url: http.url }) }, now());
    event.status = 'processing'; event.cycle_attempts = 6; event.attempts = 6; event.lease_token = 'expired'; event.lease_until = new Date(Date.now() - 1000).toISOString();
    f.state.notificationOutbox.publish([event]);
    await reconcileNotificationOutboxFor(f.deps);
    assert.equal(sends, 0); assert.equal((await f.state.notificationOutbox.get(event.event_id))?.status, 'failed');
  } finally { await http.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('native replies preserve successive approved completions while an ambiguous ACK cannot resend the same event', async () => {
  const f = await fixture(); const sends: string[] = [];
  try {
    const original = job({ source: 'wecom:synthetic-channel', metadata: { wecom_userid: 'synthetic-user' } });
    await f.state.createJob(original);
    await f.state.completeJobWithNotifications(original, { status: 'done', result: { text: 'First action complete; another approval pending' } });
    const deps = { ...f.deps, channelSendFor: async (_config: unknown, _channel: string, _recipient: string, message: unknown) => {
      sends.push(String(message)); return { ok: true };
    } };
    const complete = f.state.notificationOutbox.complete.bind(f.state.notificationOutbox);
    f.state.notificationOutbox.complete = async () => { throw new Error('synthetic ACK failure'); };
    await assert.rejects(reconcileNotificationOutboxFor(deps), /synthetic ACK failure/);
    f.state.notificationOutbox.complete = complete;
    const first = (await f.state.notificationOutbox.list({ kinds: ['delivery'] }))[0]!;
    await f.state.notificationOutbox.claim({ owner: 'recovery', kinds: ['delivery'], now: new Date(Date.now() + 120_000).toISOString() });
    assert.equal((await f.state.notificationOutbox.get(first.event_id))?.status, 'uncertain');
    assert.equal(await f.state.notificationOutbox.retry(first.event_id, { expectedStatus: 'uncertain', allowUncertain: true }), true);
    await reconcileNotificationOutboxFor(deps);
    assert.equal(sends.length, 1);
    assert.equal((await f.state.notificationOutbox.get(first.event_id))?.status, 'skipped');
    const next = await f.state.updateJob(original.job_id, { status: 'running', claim_token: 'next-approved-continuation' });
    assert.ok(next);
    await f.state.completeJobWithNotifications(next, { status: 'done', result: { text: 'All approved actions complete' } });
    await reconcileNotificationOutboxFor(deps);
    await reconcileNotificationOutboxFor(deps);
    assert.deepEqual(sends, ['First action complete; another approval pending', 'All approved actions complete']);
    const events = await f.state.notificationOutbox.list({ kinds: ['delivery'] });
    assert.equal(events.length, 2);
    const children = await Promise.all(events.map(event => f.state.findByRequestId(`deliver_${event.event_id}`)));
    assert.ok(children.every(child => child?.status === 'done'));
    assert.notEqual(children[0]!.job_id, children[1]!.job_id);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('an explicit channel route still delivers once per parent across terminal transitions', async () => {
  const f = await fixture(); let sends = 0;
  try {
    const original = job({ dispatch: { delivery: { type: 'channel', channel: 'synthetic', to: 'person' } } });
    await f.state.createJob(original);
    await f.state.completeJobWithNotifications(original, { status: 'done', result: { text: 'first result' } });
    const deps = { ...f.deps, channelSendFor: async () => { sends++; return { ok: true }; } };
    await reconcileNotificationOutboxFor(deps);
    const firstChild = await f.state.findByRequestId(`deliver_${original.job_id}`); assert.ok(firstChild);
    const next = await f.state.updateJob(original.job_id, { status: 'running', claim_token: 'second-run' }); assert.ok(next);
    await f.state.completeJobWithNotifications(next, { status: 'done', result: { text: 'second result' } });
    await reconcileNotificationOutboxFor(deps);
    assert.equal(sends, 1);
    assert.equal((await f.state.findByRequestId(`deliver_${original.job_id}`))?.job_id, firstChild.job_id);
    assert.deepEqual((await f.state.notificationOutbox.list({ kinds: ['delivery'] })).map(event => event.status).sort(), ['completed', 'skipped']);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('native delivery retains tracked best-effort failure alerts without changing its saved outcome', async () => {
  for (const breakAlertAudit of [false, true]) {
    const f = await fixture(); let alerts = 0;
    const http = await receiver((_req, res, raw) => {
      const payload = JSON.parse(raw); assert.equal(payload.kind, 'alert');
      assert.equal(payload.key, 'delivery_failed_synthetic'); alerts++; res.writeHead(200).end();
    });
    try {
      const appendAudit = f.state.appendAudit.bind(f.state);
      f.state.appendAudit = async entry => {
        if (breakAlertAudit && entry.event === 'alert') throw new Error('synthetic alert audit unavailable');
        await appendAudit(entry);
      };
      const original = job({ dispatch: { delivery: { type: 'channel', channel: 'synthetic', to: 'person' } } });
      await f.state.createJob(original);
      await f.state.completeJobWithNotifications(original, { status: 'done', result: { text: 'notification' } });
      const config = { alertRules: { matching: async () => [] }, deliveryDlq: { record: async () => {} } } as unknown as ConfigStoreContract;
      await reconcileNotificationOutboxFor({ ...f.deps, configStore: config, cfg: { ...cfg, alerts: { type: 'webhook', url: http.url, cooldown_min: 0 } },
        channelSendFor: async () => ({ ok: false, error: 'synthetic_channel_rejected' }) });
      const work = notificationBackgroundWorkFor(f.state);
      assert.equal(await work.drain(2000), true);
      assert.equal((await f.state.notificationOutbox.list({ kinds: ['delivery'] }))[0]?.status, 'failed');
      assert.equal(alerts, breakAlertAudit ? 0 : 1);
      const alert = work.snapshot().kinds.find(row => row.kind === 'alert')!;
      assert.equal(alert.inFlight, 0);
      if (breakAlertAudit) assert.equal(alert.failed, 1);
      else assert.ok(alert.completed >= 1);
    } finally { await notificationBackgroundWorkFor(f.state).drain(2000); await http.close(); await rm(f.dir, { recursive: true, force: true }); }
  }
});
