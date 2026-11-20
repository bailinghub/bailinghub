import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../app/http';
import { readHistoryCursor } from './admin-history-cursor';
import { can, type Principal } from '../app/auth';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { auditUuid, ConversationAuditError } from '../core/runtime/agent-conversation-audit';

import { ADMIN_CONVERSATION_SOURCES, type AdminConversationSource } from '../infrastructure/config/config-agent-conversation-audit-repository';

export async function handleAdminConversationAuditFor(
  store: ConfigStoreContract | null, method: string, path: string,
  req: IncomingMessage, res: ServerResponse, principal: Principal,
): Promise<boolean> {
  const base = '/admin/api/conversation-audits';
  if (path !== base && !path.startsWith(`${base}/`)) return false;
  if (principal.kind !== 'admin' || !can(principal, 'runs:read')) {
    send(res, 403, { error: 'forbidden' });
    return true;
  }
  res.setHeader('cache-control', 'no-store');
  const feed = path === `${base}/feed`;
  const detail = path.match(/^\/admin\/api\/conversation-audits\/([0-9a-f-]{36})$/i);
  if (method !== 'GET' || (path !== base && !feed && !detail)) {
    send(res, 404, { error: 'not_found' });
    return true;
  }
  if (!store?.agentConversationAudit) {
    send(res, 503, { error: 'conversation_audit_unavailable' });
    return true;
  }
  try {
    const query = new URL(req.url ?? '/', 'http://x').searchParams;
    const number = (key: string, fallback: number): number => {
      const value = query.get(key);
      if (value === null) return fallback;
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ConversationAuditError(400, 'invalid_request', 'Pagination requires non-negative safe integers.');
      return Number(value);
    };
    if (feed) {
      const source = query.get('source') ?? 'all';
      if (!ADMIN_CONVERSATION_SOURCES.includes(source as AdminConversationSource)) {
        throw new ConversationAuditError(400, 'invalid_request', 'Unknown conversation source.');
      }
      if (!store.agentConversationAudit.listFeedForAdmin) {
        send(res, 503, { error: 'conversation_feed_unavailable' });
        return true;
      }
      send(res, 200, { schema: 'bailing.admin-conversation-feed.v1',
        ...await store.agentConversationAudit.listFeedForAdmin(source as AdminConversationSource, number('limit', 50), number('offset', 0), query.get('cursor') ?? undefined) });
    } else if (path === base) {
      send(res, 200, { schema: 'bailing.agent-conversation-audit-list.v1', ...await store.agentConversationAudit.listForAdmin(number('limit', 50), number('offset', 0)) });
    } else {
      const cursor = readHistoryCursor(query, 'sequence');
      if (!cursor) throw new ConversationAuditError(400, 'invalid_request', 'Invalid history cursor.');
      const result = await store.agentConversationAudit.detailForAdmin(auditUuid(detail![1]), cursor.after, number('limit', 100), cursor.before);
      send(res, result ? 200 : 404, result ? { schema: 'bailing.agent-conversation-audit-detail.v1', ...result } : { error: 'conversation_audit_not_found' });
    }
  } catch (error) {
    if (error instanceof ConversationAuditError) send(res, error.statusCode, { error: error.code, message: error.message });
    else send(res, 500, { error: 'conversation_audit_internal_error' });
  }
  return true;
}
