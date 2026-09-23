import type { IncomingMessage, ServerResponse } from 'node:http';
import { PayloadTooLargeError, readBody, send } from '../../app/http';
import { UsageError, usageAssert } from './errors';
import { authenticateUsageIssuerRequest, authenticateUsageRequest, getUsageIdentity, usageFields, usageKey } from './identity';
import type { UsageRepository } from './repository';

export interface UsageApiDeps { usage: UsageRepository | null | undefined }
export const USAGE_CAPABILITIES = { schema: 'bailing.usage.v1', supported: true, modes: ['credits', 'periodic'],
  streaming: true, orchestration: 'host', business_authorization_unchanged: true } as const;

export function usageHttpError(res: ServerResponse, error: unknown, context: { dispatch?: 'not_dispatched' | 'unknown'; next_action?: string; operation_id?: string } = {}): void {
  const known = error instanceof UsageError, invalid = error instanceof PayloadTooLargeError || error instanceof SyntaxError;
  const code = known ? error.code : invalid ? 'USAGE_INVALID_INPUT' : 'USAGE_UNAVAILABLE';
  const dispatch = context.dispatch ?? (known && !['USAGE_PENDING','RECONCILIATION_REQUIRED'].includes(code) || invalid ? 'not_dispatched' : 'unknown');
  const resetAt = known ? error.details?.resetAt ?? error.details?.reset_at : undefined;
  const actions: Record<string, string> = {
    USAGE_UPGRADE_REQUIRED: 'upgrade_required', USAGE_IDENTITY_REQUIRED: 'reauthenticate', USAGE_IDENTITY_EXPIRED: 'reauthenticate', USAGE_ISSUER_REQUIRED: 'contact_operator',
    USAGE_ACCOUNT_FORBIDDEN: 'contact_operator', USAGE_ACCOUNT_SUSPENDED: 'contact_operator', SERVICE_NOT_ENTITLED: 'contact_operator', SUBSCRIPTION_EXPIRED: 'contact_operator',
    ALLOWANCE_INSUFFICIENT: 'contact_operator', QUOTA_WINDOW_EXHAUSTED: Number.isSafeInteger(resetAt) ? 'wait_for_reset' : 'contact_operator',
    METERING_UNAVAILABLE: 'retry_original', USAGE_UNAVAILABLE: 'retry_original', USAGE_UNSUPPORTED: 'upgrade_required',
    USAGE_OPERATION_ENDED: 'inspect_original',
    USAGE_PRICE_NOT_CONFIGURED: 'contact_operator', USAGE_PRICE_UNAVAILABLE: 'contact_operator', USAGE_PRICE_UNSUPPORTED: 'contact_operator',
    MODEL_TOOL_ADAPTER_NOT_READY: 'contact_operator',
  };
  const next_action = dispatch === 'unknown' ? 'inspect_original' : context.next_action
    ?? (known && error.details?.next_action === 'select_model' ? 'select_model' : actions[code] ?? 'resolve_error');
  const message = known ? error.message : invalid ? '请求格式不正确或超过大小限制。' : '用量服务暂时不可用，请保留原请求重试。';
  const feedback = { schema: 'bailing.usage-feedback.v1', origin: 'hub_usage', code, dispatch, next_action, retryable: dispatch === 'not_dispatched' && next_action === 'retry_original',
    ...(known && error.details?.input_limit ? { input_limit: error.details.input_limit } : {}),
    ...(Number.isSafeInteger(resetAt) ? { resetAt, reset_at: resetAt } : {}), ...(context.operation_id ? { operation_id: context.operation_id } : {}) };
  send(res, known ? error.status : error instanceof PayloadTooLargeError ? 413 : invalid ? 400 : 503,
    { ...feedback, schema: 'bailing.usage-error.v1', error: code, message, feedback,
      ...(known && code === 'USAGE_RESOURCE_IN_USE' && Array.isArray(error.details?.blockers) ? { blockers: error.details.blockers } : {}) });
}
export function usagePage(query: URLSearchParams, allow: readonly string[] = []): { limit: number; cursor: string | null } {
  const fields = ['limit', 'cursor', ...allow];
  for (const key of query.keys()) usageAssert(fields.includes(key) && query.getAll(key).length === 1, 'USAGE_INVALID_INPUT', '查询字段不正确。', 400);
  const rawLimit = query.get('limit') ?? '30';
  usageAssert(/^\d+$/.test(rawLimit), 'USAGE_INVALID_INPUT', '分页大小不正确。', 400);
  const limit = Number(rawLimit); usageAssert(limit >= 1 && limit <= 100, 'USAGE_INVALID_INPUT', '分页大小必须为 1–100。', 400);
  const cursor = query.get('cursor');
  if (cursor !== null) usageAssert(/^[A-Za-z0-9_-]{1,1024}$/.test(cursor), 'USAGE_INVALID_INPUT', '分页游标不正确。', 400);
  return { limit, cursor };
}
export function usageRevision(value: unknown): number {
  usageAssert(Number.isSafeInteger(value) && Number(value) >= 0, 'USAGE_INVALID_INPUT', '需要非负整数修订。', 400); return Number(value);
}
export function usageRequestKey(body: Record<string, unknown>): string { return usageKey(body.request_key, 'request_key'); }

/** Public usage surface intentionally never authenticates admin/client/Agent credentials. */
export async function handleUsageApiFor(deps: UsageApiDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname, method = req.method ?? 'GET';
  if (!path.startsWith('/usage/v1/') || path.startsWith('/usage/v1/model/')) return false;
  try {
    if (path === '/usage/v1/capabilities' && method === 'GET') {
      const { getBillingRepository } = await import('./billing-repository');
      const { MODEL_GATEWAY_CAPABILITIES } = await import('./model-gateway');
      const ready = Boolean(deps.usage && await getUsageIdentity(deps.usage).ready() && await getBillingRepository(deps.usage).ready());
      send(res, 200, { ...USAGE_CAPABILITIES, supported: ready, model_gateway: { ...MODEL_GATEWAY_CAPABILITIES, supported: ready } }); return true;
    }
    usageAssert(deps.usage, 'USAGE_UNSUPPORTED', '此实例未配置用量模块。', 503);
    const repository = deps.usage, identity = getUsageIdentity(repository);
    usageAssert(await identity.ready(), 'USAGE_UNSUPPORTED', '用量模块尚未就绪，请核对版本与迁移。', 503);
    if (path === '/usage/v1/sessions/exchange' && method === 'POST') {
      const { token } = await authenticateUsageIssuerRequest(identity, req, 'identity:exchange');
      send(res, 200, await identity.exchange(token, await readBody(req, 8192))); return true;
    }
    if (path === '/usage/v1/external/users/revoke' && method === 'POST') {
      const { issuer } = await authenticateUsageIssuerRequest(identity, req, 'identity:revoke');
      await identity.revokeExternalUser(issuer, await readBody(req, 4096)); send(res, 200, { revoked: true }); return true;
    }
    if (path.startsWith('/usage/v1/external/billing/')) {
      const { handleExternalBillingUsage } = await import('./billing-external');
      if (await handleExternalBillingUsage(repository, req, res, url)) return true;
    }
    if (path === '/usage/v1/session' && method === 'GET') {
      const actor = await authenticateUsageRequest(identity, req);
      send(res, 200, { schema: 'bailing.usage-session.v1', session: actor });
    } else if (path === '/usage/v1/sessions/revoke' && method === 'POST') {
      const actor = await authenticateUsageRequest(identity, req);
      usageFields(await readBody(req, 1024), []); await identity.revokeSession(actor); send(res, 200, { revoked: true });
    } else send(res, 404, { error: 'not_found' });
  } catch (error) { usageHttpError(res, error); }
  return true;
}
