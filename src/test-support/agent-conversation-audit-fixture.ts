import assert from 'node:assert/strict';
import type { AgentSession, Client } from '../core/contracts/types';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { AgentConversationAuditRepository } from '../infrastructure/config/config-agent-conversation-audit-repository';
import { parseCreateConversationAudit } from '../core/runtime/agent-conversation-audit';

type Row = Record<string, any>;
export const AUDIT_SESSION_A = '123e4567-e89b-42d3-a456-426614174001';
export const AUDIT_SESSION_B = '123e4567-e89b-42d3-a456-426614174002';
export const AUDIT_SESSION_C = '123e4567-e89b-42d3-a456-426614174003';
export const AUDIT_RUN_A = '223e4567-e89b-42d3-a456-426614174001';
export const AUDIT_RUN_B = '223e4567-e89b-42d3-a456-426614174002';
export const AUDIT_ARCHIVE = '323e4567-e89b-42d3-a456-426614174001';

function duplicate(): never { throw Object.assign(new Error('duplicate fixture key'), { code: 'ER_DUP_ENTRY' }); }

/** Synthetic SQL model for transactional repository tests; no socket, user DB or credentials. */
export function conversationAuditFixture() {
  const client: Client = {
    app_id: 'example-business', name: 'Example', token: '', agent_authorize_url: 'https://business.example.com/authorize',
    allowed_routes: ['orders'], allowed_channels: [], rate_limit_per_min: 0, enabled: true,
  };
  const route: Row = { route_key: 'orders', name: 'Orders', enabled: true, profile: 'general',
    agent_client: { enabled: true }, tools: { agent_direct: { enabled: true } } };
  const sessions = new Map<string, Row>();
  for (const [id, tenant] of [[AUDIT_SESSION_A, 'store-a'], [AUDIT_SESSION_B, 'store-b'], [AUDIT_SESSION_C, 'store-c']]) {
    sessions.set(id!, {
      session_id: id, client_app_id: client.app_id, device_label: tenant,
      principal_json: { id: 'operator-7', tenant, roles: ['manager'] }, on_behalf_of: `${tenant}:operator-7`, allowed_routes: ['orders'],
      created_at: '2026-01-01T00:00:00Z', access_expires_at: '2099-01-01T00:00:00Z', refresh_expires_at: '2099-02-01T00:00:00Z', revoked_at: null,
    });
  }
  let archives = new Map<string, Row>();
  let members = new Map<string, Row>();
  let events = new Map<string, Row>();
  const runs = new Map<string, Row>([
    [AUDIT_RUN_A, { run_id: AUDIT_RUN_A, session_id: AUDIT_SESSION_A, client_app_id: client.app_id, route_key: 'orders', thread_id: 101, client_conversation_id: 'client-conversation', client_turn_id: 'turn-1' }],
    [AUDIT_RUN_B, { run_id: AUDIT_RUN_B, session_id: AUDIT_SESSION_B, client_app_id: client.app_id, route_key: 'orders', thread_id: 102, client_conversation_id: 'client-conversation', client_turn_id: 'turn-1' }],
  ]);
  const queries: Array<{ sql: string; params: any[]; transactional: boolean }> = [];
  let transaction = false;
  let snapshot: { archives: Map<string, Row>; members: Map<string, Row>; events: Map<string, Row> };
  const query = async (sql: string, params: any[] = []): Promise<[any, any]> => {
    queries.push({ sql, params: structuredClone(params), transactional: transaction });
    if (sql.includes('FOR UPDATE')) assert.equal(transaction, true, 'locking reads must be inside the mutation transaction');
    let result: any;
    if (sql.startsWith('SELECT') && sql.includes('FROM bz_clients')) result = params[0] === client.app_id ? [client] : [];
    else if (sql.startsWith('SELECT') && sql.includes('FROM bz_routes')) result = params[0] === route.route_key ? [route] : [];
    else if (sql.startsWith('SELECT') && sql.includes('FROM bz_agent_sessions')) result = sessions.has(params[0]) ? [sessions.get(params[0])] : [];
    else if (sql.startsWith('SELECT') && sql.includes('FROM bz_agent_client_runs')) result = runs.has(params[0]) ? [runs.get(params[0])] : [];
    else if (sql.startsWith('INSERT INTO bz_agent_conversation_audits')) {
      const row = structuredClone(params[0]);
      const existing = [...archives.values()].find((item) => item.creator_session_id === row.creator_session_id && item.route_key === row.route_key && item.client_archive_id === row.client_archive_id);
      if (existing && !sql.includes('ON DUPLICATE')) duplicate();
      if (!existing) archives.set(row.conversation_id, row);
      result = { affectedRows: existing ? 0 : 1 };
    } else if (sql.startsWith('SELECT') && sql.includes('FROM bz_agent_conversation_audits')) {
      if (sql.includes('WHERE creator_session_id')) result = [...archives.values()].filter((row) => row.creator_session_id === params[0] && row.route_key === params[1] && row.client_archive_id === params[2]);
      else if (sql.includes('WHERE conversation_id')) result = archives.has(params[0]) ? [archives.get(params[0])] : [];
      else result = [...archives.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.conversation_id.localeCompare(a.conversation_id)).slice(params[1], params[1] + params[0]);
    } else if (sql.startsWith('INSERT INTO bz_agent_conversation_members')) {
      const row = structuredClone(params[0]);
      const key = `${row.conversation_id}:${row.session_id}`;
      if (members.has(key)) duplicate();
      members.set(key, row);
      result = { affectedRows: 1 };
    } else if (sql.startsWith('SELECT') && sql.includes('FROM bz_agent_conversation_members')) {
      result = [...members.values()].filter((member) => member.conversation_id === params[0]).sort((a, b) => a.session_id.localeCompare(b.session_id));
    } else if (sql.startsWith('UPDATE bz_agent_conversation_members')) {
      Object.assign(members.get(`${params[4]}:${params[5]}`)!, { identity_hash: params[0], principal_json: params[1], on_behalf_of: params[2], confirmed_at: params[3] });
      result = { affectedRows: 1 };
    } else if (sql.startsWith('UPDATE bz_agent_conversation_audits SET confirmed_count')) {
      Object.assign(archives.get(params[3])!, { confirmed_count: params[0], state: params[1], updated_at: params[2] });
      result = { affectedRows: 1 };
    } else if (sql.startsWith('UPDATE bz_agent_conversation_audits SET last_sequence')) {
      Object.assign(archives.get(params[7])!, {
        last_sequence: params[0], content_bytes: params[1], message_count: params[2], turn_count: params[3],
        last_turn_id: params[4], last_turn_status: params[5], updated_at: params[6],
      });
      result = { affectedRows: 1 };
    } else if (sql.startsWith('INSERT INTO bz_agent_conversation_events')) {
      const row = structuredClone(params[0]);
      const key = `${row.conversation_id}:${row.sequence}`;
      if (events.has(key) || [...events.values()].some((event) => (event.conversation_id === row.conversation_id && event.event_id === row.event_id) || (row.run_id && event.run_id === row.run_id))) duplicate();
      events.set(key, row);
      result = { affectedRows: 1 };
    } else if (sql.startsWith('SELECT') && sql.includes('FROM bz_agent_conversation_events')) {
      if (sql.includes('WHERE run_id')) result = [...events.values()].filter((event) => event.run_id === params[0] && event.kind === 'run_link');
      else {
        result = [...events.values()].filter((event) => event.conversation_id === params[0]);
        if (sql.includes('(sequence=? OR event_id=?)')) result = result.filter((event: Row) => event.sequence === params[1] || event.event_id === params[2]);
        else if (sql.includes("kind='turn_start'")) result = result.filter((event: Row) => event.client_turn_id === params[1] && event.kind === 'turn_start');
        else if (sql.includes('sequence>?')) result = result.filter((event: Row) => event.sequence > params[1]).sort((a: Row, b: Row) => a.sequence - b.sequence).slice(0, params[2]);
      }
    } else throw new Error(`Unexpected synthetic query: ${sql}`);
    return [structuredClone(result), []];
  };
  const connection = {
    query,
    async beginTransaction() { assert.equal(transaction, false); transaction = true; snapshot = structuredClone({ archives, members, events }); },
    async commit() { transaction = false; },
    async rollback() { ({ archives, members, events } = snapshot); transaction = false; },
    release() {},
  };
  const repo = new AgentConversationAuditRepository(() => ({ query, getConnection: async () => connection }));
  const auth = (id = AUDIT_SESSION_A) => {
    const row = sessions.get(id)!;
    return { client: structuredClone(client), session: {
      ...structuredClone(row), principal: structuredClone(row.principal_json),
    } as AgentSession };
  };
  const input = (overrides: Row = {}) => parseCreateConversationAudit({
    client_archive_id: AUDIT_ARCHIVE, client_conversation_id: 'client-conversation', route: 'orders',
    member_session_ids: [AUDIT_SESSION_A, AUDIT_SESSION_B],
    member_labels: { [AUDIT_SESSION_A]: 'Store A', [AUDIT_SESSION_B]: 'Store B' }, ...overrides,
  });
  const store = { agentConversationAudit: repo } as unknown as ConfigStoreContract;
  return {
    repo, store, auth, input, client, route, sessions, runs, queries,
    get archives() { return archives; }, get members() { return members; }, get events() { return events; },
    async ready() { const result = await repo.create(auth(), input()); return repo.confirm(auth(AUDIT_SESSION_B), String(result.conversation_id)); },
  };
}
