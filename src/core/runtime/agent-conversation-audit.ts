import { createHash } from 'node:crypto';
import type { AgentSession, Client, Route } from '../contracts/types';
import { routeAgentClientConfig } from '../config/route-config';
import { agentDirectToolsConfig } from '../config/tools-config';
import { audienceAllows } from './identity-runtime';

export const CONVERSATION_AUDIT_SCHEMA = 'bailing.agent-conversation-audit.v1';
export const CONVERSATION_AUDIT_ACK_SCHEMA = 'bailing.agent-conversation-audit-ack.v1';
export const CONVERSATION_AUDIT_CREATE_V2_SCHEMA = 'bailing.agent-conversation-audit-create.v2';
export const CONVERSATION_AUDIT_CAPABILITIES_SCHEMA = 'bailing.agent-conversation-audit-capabilities.v1';
export const CONVERSATION_AUDIT_MEMBER_BINDINGS = 'session-client-route.v1';
export const CONVERSATION_AUDIT_MAX_EVENTS = 20_000;
export const CONVERSATION_AUDIT_MAX_BYTES = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class ConversationAuditError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ConversationAuditError';
  }
}

export function auditError(code = 'conversation_audit_conflict', status = 409): never {
  throw new ConversationAuditError(status, code, status === 404
    ? 'The conversation audit is unavailable for this identity.'
    : status === 403 ? 'The frozen conversation authorization is no longer valid.'
      : status === 413 ? 'The conversation audit limit was exceeded; no events were truncated or saved.'
        : status === 503 ? 'The conversation audit capability is unavailable.'
        : 'The conversation audit request conflicts with its frozen membership or event history.');
}

function invalid(): never {
  throw new ConversationAuditError(400, 'invalid_request', 'The conversation audit request contains invalid or undeclared fields.');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!record(value) || required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
}

export function auditUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value.toLowerCase();
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) invalid();
  return value;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || CONTROL.test(value)) invalid();
  return value;
}

export interface CreateConversationAuditInput {
  client_archive_id: string;
  client_conversation_id: string;
  route: string;
  member_session_ids: string[];
  member_labels: Record<string, string>;
}

export function parseCreateConversationAudit(value: unknown): CreateConversationAuditInput {
  fields(value, ['client_archive_id', 'client_conversation_id', 'route', 'member_session_ids'], ['member_labels']);
  if (typeof value.route !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(value.route) || value.route === 'auto' ||
    !Array.isArray(value.member_session_ids) || value.member_session_ids.length < 1 || value.member_session_ids.length > 64) invalid();
  const members = value.member_session_ids.map(auditUuid).sort();
  if (new Set(members).size !== members.length) invalid();
  const labels: Record<string, string> = {};
  if (value.member_labels !== undefined) {
    if (!record(value.member_labels)) invalid();
    for (const [key, label] of Object.entries(value.member_labels)) {
      const id = auditUuid(key);
      if (!members.includes(id) || Object.hasOwn(labels, id)) invalid();
      labels[id] = text(label, 128);
    }
  }
  return {
    client_archive_id: auditUuid(value.client_archive_id),
    client_conversation_id: identifier(value.client_conversation_id),
    route: value.route, member_session_ids: members, member_labels: labels,
  };
}

export interface ConversationAuditMemberBindingInput {
  session_id: string;
  client_app_id: string;
  route: string;
  label?: string;
}

export interface CreateCrossBindingConversationAuditInput {
  schema: typeof CONVERSATION_AUDIT_CREATE_V2_SCHEMA;
  client_archive_id: string;
  client_conversation_id: string;
  members: ConversationAuditMemberBindingInput[];
}

/** Explicit opt-in: v1 callers never acquire cross-client or cross-route scope. */
export function parseCreateCrossBindingConversationAudit(value: unknown): CreateCrossBindingConversationAuditInput {
  fields(value, ['schema', 'client_archive_id', 'client_conversation_id', 'members']);
  if (value.schema !== CONVERSATION_AUDIT_CREATE_V2_SCHEMA || !Array.isArray(value.members) ||
    value.members.length < 1 || value.members.length > 64) invalid();
  const members = value.members.map((raw): ConversationAuditMemberBindingInput => {
    fields(raw, ['session_id', 'client_app_id', 'route'], ['label']);
    if (typeof raw.client_app_id !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(raw.client_app_id) ||
      typeof raw.route !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(raw.route) || raw.route === 'auto') invalid();
    return {
      session_id: auditUuid(raw.session_id), client_app_id: raw.client_app_id, route: raw.route,
      ...(raw.label !== undefined ? { label: text(raw.label, 128) } : {}),
    };
  }).sort((a, b) => a.session_id.localeCompare(b.session_id));
  // One session cannot identify two targets, even if both routes are permitted.
  if (new Set(members.map((member) => member.session_id)).size !== members.length) invalid();
  return { schema: CONVERSATION_AUDIT_CREATE_V2_SCHEMA,
    client_archive_id: auditUuid(value.client_archive_id),
    client_conversation_id: identifier(value.client_conversation_id), members };
}

export type ConversationAuditEventKind = 'turn_start' | 'user_message' | 'assistant_message' | 'run_link' | 'turn_end';
export type ConversationAuditTurnStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export interface ConversationAuditEventInput {
  event_id: string;
  sequence: number;
  client_turn_id: string;
  kind: ConversationAuditEventKind;
  content?: string;
  run_id?: string;
  member_session_id?: string;
  status?: Exclude<ConversationAuditTurnStatus, 'running'>;
}

export function parseConversationAuditEvents(value: unknown): ConversationAuditEventInput[] {
  fields(value, ['events']);
  if (!Array.isArray(value.events) || value.events.length < 1 || value.events.length > 50) invalid();
  const events = value.events.map((raw): ConversationAuditEventInput => {
    const common = ['event_id', 'sequence', 'client_turn_id', 'kind'];
    if (!record(raw)) invalid();
    if (raw.kind === 'user_message' || raw.kind === 'assistant_message') fields(raw, [...common, 'content']);
    else if (raw.kind === 'run_link') fields(raw, [...common, 'run_id', 'member_session_id']);
    else if (raw.kind === 'turn_end') fields(raw, [...common, 'status']);
    else if (raw.kind === 'turn_start') fields(raw, common);
    else invalid();
    if (!Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 1) invalid();
    if (Number(raw.sequence) > CONVERSATION_AUDIT_MAX_EVENTS) auditError('conversation_audit_limit', 413);
    const event: ConversationAuditEventInput = {
      event_id: identifier(raw.event_id), sequence: Number(raw.sequence), client_turn_id: identifier(raw.client_turn_id),
      kind: raw.kind as ConversationAuditEventKind,
    };
    if (raw.kind === 'user_message' || raw.kind === 'assistant_message') event.content = text(raw.content, 64_000);
    if (raw.kind === 'run_link') {
      event.run_id = auditUuid(raw.run_id);
      event.member_session_id = auditUuid(raw.member_session_id);
    }
    if (raw.kind === 'turn_end') {
      if (!['completed', 'failed', 'cancelled'].includes(String(raw.status))) invalid();
      event.status = raw.status as ConversationAuditEventInput['status'];
    }
    return event;
  });
  if (new Set(events.map((event) => event.event_id)).size !== events.length ||
    events.some((event, index) => index > 0 && event.sequence !== events[index - 1]!.sequence + 1)) invalid();
  if (events.reduce((sum, event) => sum + Buffer.byteLength(event.content ?? '', 'utf8'), 0) > 256 * 1024) auditError('conversation_audit_limit', 413);
  return events;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function auditHash(value: unknown): string {
  return createHash('sha256').update(stable(value), 'utf8').digest('hex');
}

export function auditIdentityHash(session: AgentSession): string {
  return auditHash({ session_id: session.session_id, client_app_id: session.client_app_id, principal: session.principal, on_behalf_of: session.on_behalf_of });
}

/** The same route restrictions as Agent Runtime; group membership never expands them. */
export function assertAuditMemberActive(session: AgentSession, client: Client, route: Route, expectedIdentity?: string): void {
  const allowed = (routes: string[]) => Array.isArray(routes) && (routes.includes('*') || routes.includes(route.route_key));
  if (session.revoked_at || !Number.isFinite(Date.parse(session.refresh_expires_at)) || Date.parse(session.refresh_expires_at) <= Date.now() ||
    session.client_app_id !== client.app_id || !client.enabled || !client.agent_authorize_url || !route.enabled ||
    !allowed(client.allowed_routes) || !allowed(session.allowed_routes) || !routeAgentClientConfig(route) || !agentDirectToolsConfig(route.tools) ||
    (expectedIdentity !== undefined && auditIdentityHash(session) !== expectedIdentity) ||
    !audienceAllows(route.audience, { ...session.principal, client_app_id: client.app_id, channel: session.principal.channel ?? `agent:${client.app_id}` }).ok) {
    auditError('conversation_audit_authorization_invalid', 403);
  }
}
