import type { IncomingMessage, ServerResponse } from 'node:http';
import { PayloadTooLargeError, readBody, send } from '../app/http';
import type { AgentToolAuthContext } from '../app/agent-tool-invocations';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { createConversationAuditFor, confirmConversationAuditFor, appendConversationAuditFor, conversationAuditCapabilitiesFor } from '../app/agent-conversation-audit';
import { ConversationAuditError } from '../core/runtime/agent-conversation-audit';

/** Agent write-only ledger; the sole GET exposes capability metadata, never text. */
export async function handleAgentConversationAuditFor(
  store: ConfigStoreContract | null, auth: AgentToolAuthContext,
  req: IncomingMessage, res: ServerResponse, path: string,
): Promise<boolean> {
  const base = '/agent-api/v1/conversation-audits';
  if (path !== base && !path.startsWith(`${base}/`)) return false;
  res.setHeader('cache-control', 'no-store');
  if (path === `${base}/capabilities` && req.method === 'GET') {
    try { send(res, 200, await conversationAuditCapabilitiesFor(store)); }
    catch { send(res, 503, { error: 'conversation_audit_unavailable' }); }
    return true;
  }
  const member = path.match(/^\/agent-api\/v1\/conversation-audits\/([0-9a-f-]{36})\/(confirm|events)$/i);
  if (req.method !== 'POST' || (path !== base && !member)) {
    send(res, 404, { error: 'not_found' });
    return true;
  }
  try {
    const body = await readBody(req, 2 * 1024 * 1024);
    const result = path === base ? await createConversationAuditFor(store, auth, body)
      : member![2] === 'confirm' ? await confirmConversationAuditFor(store, auth, member![1]!, body)
        : await appendConversationAuditFor(store, auth, member![1]!, body);
    send(res, 200, result);
  } catch (error) {
    if (error instanceof ConversationAuditError) send(res, error.statusCode, { error: error.code, message: error.message });
    else if (error instanceof PayloadTooLargeError) send(res, 413, { error: 'conversation_audit_limit' });
    else if (error instanceof SyntaxError) send(res, 400, { error: 'invalid_request' });
    else send(res, 500, { error: 'conversation_audit_internal_error', message: 'The conversation audit operation failed.' });
  }
  return true;
}
