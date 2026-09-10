import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { AgentToolAuthContext } from './agent-tool-invocations';
import {
  auditUuid, parseCreateConversationAudit, parseConversationAuditEvents, ConversationAuditError,
  CONVERSATION_AUDIT_SCHEMA, CONVERSATION_AUDIT_ACK_SCHEMA,
  CONVERSATION_AUDIT_CREATE_V2_SCHEMA, CONVERSATION_AUDIT_CAPABILITIES_SCHEMA,
  CONVERSATION_AUDIT_MEMBER_BINDINGS, parseCreateCrossBindingConversationAudit,
} from '../core/runtime/agent-conversation-audit';

function repository(configStore: ConfigStoreContract | null) {
  if (!configStore?.agentConversationAudit) {
    throw new ConversationAuditError(503, 'conversation_audit_unavailable', 'Conversation audit storage is unavailable.');
  }
  return configStore.agentConversationAudit;
}

export async function createConversationAuditFor(store: ConfigStoreContract | null, auth: AgentToolAuthContext, body: unknown) {
  if (body && typeof body === 'object' && 'schema' in body && body.schema === CONVERSATION_AUDIT_CREATE_V2_SCHEMA) {
    const input = parseCreateCrossBindingConversationAudit(body);
    const repo = repository(store);
    if (typeof repo.createCrossBinding !== 'function' || typeof repo.supportsCrossBindingMembers !== 'function' ||
      await repo.supportsCrossBindingMembers() !== true) {
      throw new ConversationAuditError(503, 'conversation_audit_cross_binding_unavailable', 'Cross-binding conversation audit storage is unavailable.');
    }
    return { schema: CONVERSATION_AUDIT_SCHEMA, ...await repo.createCrossBinding(auth, input) };
  }
  const input = parseCreateConversationAudit(body);
  return { schema: CONVERSATION_AUDIT_SCHEMA, ...await repository(store).create(auth, input) };
}

/** No sessions, account names, identifiers or transcript data are discovered here. */
export async function conversationAuditCapabilitiesFor(store: ConfigStoreContract | null) {
  const repo = store?.agentConversationAudit;
  const supported = typeof repo?.createCrossBinding === 'function' && typeof repo.supportsCrossBindingMembers === 'function' &&
    await repo.supportsCrossBindingMembers() === true;
  return { schema: CONVERSATION_AUDIT_CAPABILITIES_SCHEMA,
    cross_binding_members: supported, member_bindings: CONVERSATION_AUDIT_MEMBER_BINDINGS };
}

export async function confirmConversationAuditFor(store: ConfigStoreContract | null, auth: AgentToolAuthContext, id: string, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
    throw new ConversationAuditError(400, 'invalid_request', 'Member confirmation requires an empty object; identity comes from the bearer.');
  }
  return { schema: CONVERSATION_AUDIT_SCHEMA, ...await repository(store).confirm(auth, auditUuid(id)) };
}

export async function appendConversationAuditFor(store: ConfigStoreContract | null, auth: AgentToolAuthContext, id: string, body: unknown) {
  const events = parseConversationAuditEvents(body);
  return { schema: CONVERSATION_AUDIT_ACK_SCHEMA, ...await repository(store).append(auth, auditUuid(id), events) };
}
