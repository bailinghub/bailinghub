import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../core/config/config';
import type { NotificationEvent, NotificationOutboxRepository, NotificationKind, ApprovalNotificationPayload } from '../core/contracts/notification-outbox';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { defaultTargetRegistry, type TargetRegistry } from '../core/targets/registry';
import { notificationBackgroundWorkFor } from '../core/runtime/notification-background-work';
import { deliveryFailureRecipient } from '../core/runtime/finish-runtime';
import { channelSendFor } from './channels';
import { deliverNotificationFor } from './delivery';
import { notifyApprovalPayloadFor } from './tool-approvals';
import { outboundRuntimeDepsFor, postSignedNotificationWithDeps, secretForJobWithDeps, type NotificationSendOutcome } from './outbound';

export interface NotificationOutboxDeps {
  cfg: AppConfig;
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  targetRegistry?: TargetRegistry;
  channelSendFor?: typeof channelSendFor;
  isClosing?: () => boolean;
}

const LEASE_MS = 90_000;
const MAX_CYCLE_ATTEMPTS = 6;
const flights = new WeakMap<object, Promise<void>>();

async function sendEvent(deps: NotificationOutboxDeps, event: NotificationEvent): Promise<NotificationSendOutcome> {
  const job = event.payload.job;
  if (event.kind === 'callback') {
    if (!job.callback_url) return { status: 'skipped', error: 'Callback destination missing' };
    const outbound = outboundRuntimeDepsFor(deps);
    return postSignedNotificationWithDeps(outbound, job.callback_url, { ...job }, await secretForJobWithDeps(outbound, job), event.event_id,
      { job_id: job.job_id, request_id: job.request_id, event: 'callback' });
  }
  if (event.kind === 'delivery') return deliverNotificationFor(deps, job, event.event_id, event.payload.brand_name ?? 'BailingHub');
  if (event.kind === 'approval-notification') {
    if (!('approval_id' in event.payload)) return { status: 'failed', error: 'Invalid approval notification payload' };
    return notifyApprovalPayloadFor(deps.configStore, deps.stateStore, event.payload as ApprovalNotificationPayload, deps.cfg,
      deps.now, deps.sleep, deps.targetRegistry ?? defaultTargetRegistry, event.event_id);
  }
  if (!deps.configStore) return { status: 'failed', error: 'Delivery dead letter repository unavailable' };
  await deps.configStore.deliveryDlq.record({ parentJobId: job.job_id, channel: String(job.target ?? ''),
    recipient: deliveryFailureRecipient(job), content: job.input ?? '', error: String(job.error ?? 'Delivery failed').slice(0, 200),
    deliveryKind: 'executor_target', notificationJobId: job.job_id, eventId: event.event_id });
  return { status: 'completed' };
}

async function processEvent(deps: NotificationOutboxDeps, repository: NotificationOutboxRepository, event: NotificationEvent): Promise<void> {
  const token = event.lease_token;
  if (!token) throw new Error('Notification claim has no fencing token');
  if (event.cycle_attempts > MAX_CYCLE_ATTEMPTS) {
    // Repeated process crashes can consume claims without reaching fail().
    await repository.fail(event.event_id, token, { status: 'failed', error: 'notification_attempt_limit' });
    return;
  }
  let lost = false;
  let renewing: Promise<void> | null = null;
  const renew = () => {
    if (renewing || lost) return;
    renewing = repository.renew(event.event_id, token, LEASE_MS)
      .then(ok => { if (!ok) lost = true; }, () => { lost = true; })
      .finally(() => { renewing = null; });
  };
  renew();
  await renewing;
  if (lost) return;
  const timer = setInterval(renew, LEASE_MS / 3);
  timer.unref();
  let outcome: NotificationSendOutcome;
  try {
    try { outcome = await sendEvent(deps, event); }
    catch {
      // Native-channel acknowledgement or local bookkeeping can be ambiguous.
      // Do not persist exception text containing destinations, SQL or credentials.
      outcome = { status: event.recovery === 'uncertain' ? 'uncertain' : 'retry', error: 'Notification attempt interrupted' };
    }
    clearInterval(timer);
    if (renewing) await renewing;
    if (lost) return; // An expired owner cannot acknowledge a newer claim.
    if (outcome.status === 'completed' || outcome.status === 'skipped') {
      const completed = await repository.complete(event.event_id, token, outcome.status, outcome.error);
      if (completed && event.kind === 'delivery') {
        // Delivery is already acknowledged. A bookkeeping failure must not send it again.
        await deps.configStore?.deliveryDlq.resolveByEventId?.(event.event_id).catch(() => undefined);
      }
      return;
    }
    const retry = outcome.status === 'retry' && event.cycle_attempts < MAX_CYCLE_ATTEMPTS;
    const status = retry ? 'pending' : outcome.status === 'uncertain' ? 'uncertain' : 'failed';
    const delay = Math.min(300_000, 2_000 * 2 ** Math.max(0, event.cycle_attempts - 1));
    await repository.fail(event.event_id, token, { status, error: outcome.error ?? 'Notification delivery failed',
      ...(retry ? { availableAt: new Date(Date.parse(deps.now()) + delay).toISOString() } : {}) });
  } finally {
    clearInterval(timer);
    if (renewing) await renewing;
  }
}

/** Bounded maintenance pass. Only persisted notification intents are scanned. */
export function reconcileNotificationOutboxFor(deps: NotificationOutboxDeps): Promise<void> {
  const existing = flights.get(deps.stateStore);
  if (existing) return existing;
  const work = (async () => {
    const sources: Array<{ repository: NotificationOutboxRepository; kinds: NotificationKind[] }> = [];
    if (deps.stateStore.notificationOutbox) sources.push({ repository: deps.stateStore.notificationOutbox, kinds: ['callback', 'delivery', 'delivery-dlq'] });
    if (deps.configStore?.notificationOutbox) sources.push({ repository: deps.configStore.notificationOutbox, kinds: ['approval-notification'] });
    const owner = `notification:${randomUUID()}`;
    for (const { repository, kinds } of sources) {
      // Claim one at a time, so later rows do not lose leases while earlier I/O runs.
      for (let count = 0; count < 10 && !deps.isClosing?.(); count++) {
        const events = await repository.claim({ owner, kinds, limit: 1, leaseMs: LEASE_MS, now: deps.now() });
        const event = events[0];
        if (!event) break;
        await notificationBackgroundWorkFor(deps.stateStore).track(event.kind, () => processEvent(deps, repository, event));
      }
    }
  })();
  flights.set(deps.stateStore, work);
  void work.finally(() => { if (flights.get(deps.stateStore) === work) flights.delete(deps.stateStore); }).catch(() => undefined);
  return work;
}
