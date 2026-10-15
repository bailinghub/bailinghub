import type { IncomingMessage, ServerResponse } from 'node:http';
import { can, type Principal } from '../app/auth';
import { readBody, send } from '../app/http';
import { NOTIFICATION_KINDS, NOTIFICATION_STATUSES, type NotificationKind, type NotificationStatus } from '../core/contracts/notification-outbox';
import { wakeNotificationOutboxFor } from '../core/runtime/notification-outbox-work';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { safeNotificationError } from '../core/state/notification-outbox';

interface Deps { stateStore: RuntimeStateStore; configStore: ConfigStoreContract | null; now(): string }

/** Admin-only summaries deliberately omit payload, destinations, credentials and lease tokens. */
export async function handleAdminNotificationsFor(deps: Deps, method: string, path: string,
  req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<boolean> {
  if (path !== '/admin/api/notification-outbox' && !path.startsWith('/admin/api/notification-outbox/')) return false;
  if (!can(principal, method === 'GET' ? 'runs:read' : 'runs:write')) {
    send(res, 403, { error: '当前角色无此权限' }); return true;
  }
  const query = new URL(req.url ?? path, 'http://localhost').searchParams;
  const input = method === 'POST' ? await readBody(req) : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    send(res, 400, { error: 'notification_retry_invalid' }); return true;
  }
  const body = input as Record<string, unknown>;
  const rawKind = method === 'GET' ? query.get('kind') ?? 'callback' : body['kind'];
  if (!NOTIFICATION_KINDS.includes(rawKind as NotificationKind)) {
    send(res, 400, { error: 'notification_kind_invalid' }); return true;
  }
  const kind = rawKind as NotificationKind;
  const repository = kind === 'approval-notification'
    ? (deps.configStore?.approvals?.createWithNotification ? deps.configStore.notificationOutbox : undefined)
    : (deps.stateStore.completeJobWithNotifications ? deps.stateStore.notificationOutbox : undefined);
  if (!repository) { send(res, 503, { error: 'notification_durability_unavailable' }); return true; }
  if (path === '/admin/api/notification-outbox' && method === 'GET') {
    const status = query.get('status');
    const offset = Number(query.get('offset') ?? 0);
    if ((status && !NOTIFICATION_STATUSES.includes(status as NotificationStatus)) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
      send(res, 400, { error: 'notification_filter_invalid' }); return true;
    }
    const [rows, snapshot] = await Promise.all([
      repository.list({ kinds: [kind], ...(status ? { statuses: [status as NotificationStatus] } : {}), limit: 20, offset }),
      repository.snapshot({ kinds: [kind] }),
    ]);
    const total = status ? snapshot.counts[status as NotificationStatus] : Object.values(snapshot.counts).reduce((sum, n) => sum + n, 0);
    send(res, 200, { capability: 'durable', snapshot, total, limit: 20, offset,
      items: rows.map(row => ({ event_id: row.event_id, kind: row.kind, job_id: row.job_id,
        request_id: row.request_id, status: row.status, attempts: row.attempts,
        created_at: row.created_at, updated_at: row.updated_at, available_at: row.available_at,
        completed_at: row.completed_at ?? null,
        last_error: safeNotificationError(row.last_error) ?? null,
      })) });
    return true;
  }
  const match = path.match(/^\/admin\/api\/notification-outbox\/([^/]+)\/retry$/);
  if (match && method === 'POST') {
    let eventId: string;
    try { eventId = decodeURIComponent(match[1]!); } catch { send(res, 400, { error: 'notification_id_invalid' }); return true; }
    const expectedStatus = body['expected_status'];
    if (eventId.length > 191 || !eventId || !['failed', 'uncertain'].includes(String(expectedStatus))) {
      send(res, 400, { error: 'notification_retry_invalid' }); return true;
    }
    if (expectedStatus === 'uncertain' && body['allow_uncertain'] !== true) {
      send(res, 409, { error: 'notification_uncertain_requires_confirmation' }); return true;
    }
    const event = await repository.get(eventId);
    if (!event || event.kind !== kind) { send(res, 404, { error: 'notification_not_found' }); return true; }
    const queued = await repository.retry(eventId, { expectedStatus: expectedStatus as 'failed' | 'uncertain',
      allowUncertain: body['allow_uncertain'] === true });
    if (!queued) { send(res, 409, { error: 'notification_status_changed' }); return true; }
    await deps.stateStore.appendAudit({ ts: deps.now(), job_id: event.job_id, request_id: event.request_id,
      event: 'notification_retry_requested', detail: { event_id: eventId, kind, previous_status: expectedStatus } }).catch(() => undefined);
    wakeNotificationOutboxFor(deps.stateStore);
    send(res, 200, { queued: true, event_id: eventId });
    return true;
  }
  send(res, 404, { error: 'not_found' }); return true;
}
