import { randomUUID } from 'node:crypto';
import { dt, rowClient, rowRoute } from '../../core/config/config-codec';
import type { AgentSession, Client, Route } from '../../core/contracts/types';
import {
  assertAuditMemberActive, auditError, auditHash, auditIdentityHash,
  CONVERSATION_AUDIT_MAX_BYTES, CONVERSATION_AUDIT_MAX_EVENTS,
  type CreateConversationAuditInput, type ConversationAuditEventInput,
} from '../../core/runtime/agent-conversation-audit';

type Auth = { session: AgentSession; client: Client };
type Row = Record<string, any>;
const SESSION_COLUMNS = 'session_id,client_app_id,device_label,principal_json,on_behalf_of,allowed_routes,created_at,access_expires_at,refresh_expires_at,revoked_at';

function json(value: unknown): any {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function iso(value: any): string {
  return new Date(value).toISOString();
}

function sessionOf(row: Row): AgentSession {
  return {
    session_id: String(row.session_id), client_app_id: String(row.client_app_id), device_label: String(row.device_label),
    principal: json(row.principal_json), on_behalf_of: String(row.on_behalf_of), allowed_routes: json(row.allowed_routes),
    created_at: iso(row.created_at), access_expires_at: iso(row.access_expires_at), refresh_expires_at: iso(row.refresh_expires_at),
    ...(row.revoked_at ? { revoked_at: iso(row.revoked_at) } : {}),
  };
}

function head(row: Row): Row {
  return {
    conversation_id: row.conversation_id, client_archive_id: row.client_archive_id,
    client_conversation_id: row.client_conversation_id, client_app_id: row.client_app_id, route_key: row.route_key,
    state: row.state, member_count: Number(row.member_count), confirmed_count: Number(row.confirmed_count),
    last_sequence: Number(row.last_sequence), message_count: Number(row.message_count), turn_count: Number(row.turn_count),
    last_turn_status: row.last_turn_status ?? null, created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  };
}

function eventView(row: Row): Row {
  return {
    event_id: row.event_id, sequence: Number(row.sequence), client_turn_id: row.client_turn_id, kind: row.kind,
    ...(row.content !== null && row.content !== undefined ? { content: row.content } : {}),
    ...(row.run_id ? { run_id: row.run_id, member_session_id: row.member_session_id, thread_id: Number(row.thread_id) } : {}),
    ...(row.status ? { status: row.status } : {}), created_at: iso(row.created_at),
  };
}

/** Separate audit ledger: no conversation body is added to bz_messages or memory. */
export class AgentConversationAuditRepository {
  constructor(private readonly poolOf: () => any) {}
  private get pool(): any { return this.poolOf(); }

  private async transaction<T>(work: (connection: any) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') auditError();
      throw error;
    } finally { connection.release(); }
  }

  /** Lock the authorization configuration until commit, including revoke/refresh rows. */
  private async lockedBinding(connection: any, clientAppId: string, routeKey: string): Promise<{ client: Client; route: Route }> {
    const [clients] = await connection.query(
      'SELECT app_id,name,agent_authorize_url,allowed_routes,allowed_channels,enabled FROM bz_clients WHERE app_id=? FOR UPDATE', [clientAppId],
    );
    const [routes] = await connection.query('SELECT * FROM bz_routes WHERE route_key=? FOR UPDATE', [routeKey]);
    if (!clients[0] || !routes[0]) auditError('conversation_audit_authorization_invalid', 403);
    return { client: rowClient(clients[0]), route: rowRoute(routes[0]) };
  }

  private async lockedSession(connection: any, id: string, binding: { client: Client; route: Route }, expectedIdentity?: string): Promise<AgentSession> {
    const [rows] = await connection.query(`SELECT ${SESSION_COLUMNS} FROM bz_agent_sessions WHERE session_id=? FOR UPDATE`, [id]);
    if (!rows[0]) auditError('conversation_audit_authorization_invalid', 403);
    const session = sessionOf(rows[0]);
    assertAuditMemberActive(session, binding.client, binding.route, expectedIdentity);
    return session;
  }

  private async lockedConversation(connection: any, id: string, auth: Auth, creatorOnly: boolean): Promise<{ row: Row; members: Row[] }> {
    const [rows] = await connection.query('SELECT * FROM bz_agent_conversation_audits WHERE conversation_id=? FOR UPDATE', [id]);
    const row = rows[0] as Row | undefined;
    if (!row || row.client_app_id !== auth.client.app_id || (creatorOnly && row.creator_session_id !== auth.session.session_id)) {
      auditError('conversation_audit_not_found', 404);
    }
    const [members] = await connection.query('SELECT * FROM bz_agent_conversation_members WHERE conversation_id=? ORDER BY session_id FOR UPDATE', [id]);
    if (!(members as Row[]).some((member) => member.session_id === auth.session.session_id)) auditError('conversation_audit_not_found', 404);
    return { row, members };
  }

  async create(auth: Auth, input: CreateConversationAuditInput): Promise<Row> {
    if (!input.member_session_ids.includes(auth.session.session_id)) auditError('conversation_audit_not_found', 404);
    return this.transaction(async (connection) => {
      const enrollmentHash = auditHash(input);
      const at = dt();
      const row = {
        conversation_id: randomUUID(), creator_session_id: auth.session.session_id, client_app_id: auth.client.app_id,
        route_key: input.route, client_archive_id: input.client_archive_id, client_conversation_id: input.client_conversation_id,
        enrollment_hash: enrollmentHash, state: input.member_session_ids.length === 1 ? 'ready' : 'enrolling',
        member_count: input.member_session_ids.length, confirmed_count: 1, last_sequence: 0, content_bytes: 0,
        message_count: 0, turn_count: 0, last_turn_id: null, last_turn_status: null, created_at: at, updated_at: at,
      };
      // Acquire the group lock first for every mutation. The unique archive key
      // also makes concurrent identical creation retryable without a second group.
      await connection.query('INSERT INTO bz_agent_conversation_audits SET ? ON DUPLICATE KEY UPDATE conversation_id=conversation_id', [row]);
      const [existing] = await connection.query(
        'SELECT * FROM bz_agent_conversation_audits WHERE creator_session_id=? AND route_key=? AND client_archive_id=? FOR UPDATE',
        [auth.session.session_id, input.route, input.client_archive_id],
      );
      const stored = existing[0];
      if (!stored || stored.client_app_id !== auth.client.app_id || stored.enrollment_hash !== enrollmentHash) auditError();
      const binding = await this.lockedBinding(connection, auth.client.app_id, input.route);
      const creator = await this.lockedSession(connection, auth.session.session_id, binding, auditIdentityHash(auth.session));
      if (stored.conversation_id !== row.conversation_id) return head(stored);
      for (const id of input.member_session_ids) {
        const confirmed = id === creator.session_id;
        await connection.query('INSERT INTO bz_agent_conversation_members SET ?', [{
          conversation_id: row.conversation_id, session_id: id, display_label: input.member_labels[id] ?? id,
          identity_hash: confirmed ? auditIdentityHash(creator) : null,
          principal_json: confirmed ? JSON.stringify(creator.principal) : null,
          on_behalf_of: confirmed ? creator.on_behalf_of : null, confirmed_at: confirmed ? at : null,
        }]);
      }
      return head(row);
    });
  }

  async confirm(auth: Auth, conversationId: string): Promise<Row> {
    return this.transaction(async (connection) => {
      const { row, members } = await this.lockedConversation(connection, conversationId, auth, false);
      const binding = await this.lockedBinding(connection, row.client_app_id, row.route_key);
      const member = members.find((candidate) => candidate.session_id === auth.session.session_id)!;
      const session = await this.lockedSession(connection, member.session_id, binding, member.identity_hash ?? auditIdentityHash(auth.session));
      if (auditIdentityHash(session) !== auditIdentityHash(auth.session)) auditError('conversation_audit_authorization_invalid', 403);
      const at = dt();
      if (!member.confirmed_at) {
        await connection.query(
          'UPDATE bz_agent_conversation_members SET identity_hash=?,principal_json=?,on_behalf_of=?,confirmed_at=? WHERE conversation_id=? AND session_id=?',
          [auditIdentityHash(session), JSON.stringify(session.principal), session.on_behalf_of, at, conversationId, session.session_id],
        );
        member.identity_hash = auditIdentityHash(session);
        member.confirmed_at = at;
      }
      const confirmed = members.filter((candidate) => candidate.confirmed_at).length;
      if (confirmed === members.length) {
        for (const candidate of members) await this.lockedSession(connection, candidate.session_id, binding, candidate.identity_hash);
      }
      row.confirmed_count = confirmed;
      row.state = confirmed === members.length ? 'ready' : 'enrolling';
      row.updated_at = at;
      await connection.query('UPDATE bz_agent_conversation_audits SET confirmed_count=?,state=?,updated_at=? WHERE conversation_id=?',
        [confirmed, row.state, at, conversationId]);
      return head(row);
    });
  }

  async append(auth: Auth, conversationId: string, events: ConversationAuditEventInput[]): Promise<Row> {
    return this.transaction(async (connection) => {
      const { row, members } = await this.lockedConversation(connection, conversationId, auth, true);
      if (row.state !== 'ready' || members.length !== Number(row.member_count) || members.some((member) => !member.confirmed_at)) {
        auditError('conversation_audit_not_ready');
      }
      const binding = await this.lockedBinding(connection, row.client_app_id, row.route_key);
      for (const member of members) {
        const session = await this.lockedSession(connection, member.session_id, binding, member.identity_hash);
        if (session.session_id === auth.session.session_id && auditIdentityHash(session) !== auditIdentityHash(auth.session)) {
          auditError('conversation_audit_authorization_invalid', 403);
        }
      }
      const at = dt();
      for (const event of events) {
        const eventHash = auditHash(event);
        const [duplicates] = await connection.query(
          'SELECT sequence,event_id,event_hash FROM bz_agent_conversation_events WHERE conversation_id=? AND (sequence=? OR event_id=?)',
          [conversationId, event.sequence, event.event_id],
        );
        if (duplicates.length) {
          if (duplicates.length !== 1 || Number(duplicates[0].sequence) !== event.sequence || duplicates[0].event_id !== event.event_id || duplicates[0].event_hash !== eventHash) auditError();
          continue;
        }
        if (event.sequence !== Number(row.last_sequence) + 1) auditError();
        const contentBytes = Buffer.byteLength(event.content ?? '', 'utf8');
        if (event.sequence > CONVERSATION_AUDIT_MAX_EVENTS || Number(row.content_bytes) + contentBytes > CONVERSATION_AUDIT_MAX_BYTES) auditError('conversation_audit_limit', 413);
        if (event.kind === 'turn_start') {
          const [started] = await connection.query("SELECT sequence FROM bz_agent_conversation_events WHERE conversation_id=? AND client_turn_id=? AND kind='turn_start' LIMIT 1", [conversationId, event.client_turn_id]);
          if (row.last_turn_status === 'running' || started.length) auditError();
          row.last_turn_id = event.client_turn_id;
          row.last_turn_status = 'running';
          row.turn_count = Number(row.turn_count) + 1;
        } else if (event.kind === 'run_link') {
          // A startTurn response may arrive after cancellation/end, or while the
          // next turn is running. Late execution evidence belongs to its original
          // started turn and must never reopen or change the current turn.
          const [started] = await connection.query("SELECT sequence FROM bz_agent_conversation_events WHERE conversation_id=? AND client_turn_id=? AND kind='turn_start' LIMIT 1", [conversationId, event.client_turn_id]);
          if (!started.length) auditError();
        } else if (row.last_turn_status !== 'running' || row.last_turn_id !== event.client_turn_id) auditError();
        let threadId: number | null = null;
        if (event.kind === 'run_link') {
          if (!members.some((member) => member.session_id === event.member_session_id)) auditError();
          const [runs] = await connection.query(
            'SELECT run_id,session_id,client_app_id,route_key,thread_id,client_conversation_id,client_turn_id FROM bz_agent_client_runs WHERE run_id=? FOR UPDATE', [event.run_id],
          );
          const run = runs[0];
          if (!run || run.session_id !== event.member_session_id || run.client_app_id !== row.client_app_id || run.route_key !== row.route_key ||
            run.client_conversation_id !== row.client_conversation_id || run.client_turn_id !== event.client_turn_id || !Number(run.thread_id)) auditError();
          threadId = Number(run.thread_id);
        }
        if (event.kind === 'turn_end') row.last_turn_status = event.status;
        if (event.kind === 'user_message' || event.kind === 'assistant_message') row.message_count = Number(row.message_count) + 1;
        await connection.query('INSERT INTO bz_agent_conversation_events SET ?', [{
          conversation_id: conversationId, sequence: event.sequence, event_id: event.event_id, client_turn_id: event.client_turn_id,
          kind: event.kind, content: event.content ?? null, run_id: event.run_id ?? null, member_session_id: event.member_session_id ?? null,
          thread_id: threadId, status: event.status ?? null, event_hash: eventHash, created_at: at,
        }]);
        row.last_sequence = event.sequence;
        row.content_bytes = Number(row.content_bytes) + contentBytes;
      }
      await connection.query(
        'UPDATE bz_agent_conversation_audits SET last_sequence=?,content_bytes=?,message_count=?,turn_count=?,last_turn_id=?,last_turn_status=?,updated_at=? WHERE conversation_id=?',
        [row.last_sequence, row.content_bytes, row.message_count, row.turn_count, row.last_turn_id, row.last_turn_status, at, conversationId],
      );
      return { conversation_id: conversationId, last_sequence: Number(row.last_sequence) };
    });
  }

  async listForAdmin(limit = 50, offset = 0): Promise<Row> {
    const n = Math.min(Math.max(Math.floor(limit) || 50, 1), 100);
    const off = Math.max(Math.floor(offset) || 0, 0);
    const [rows] = await this.pool.query('SELECT * FROM bz_agent_conversation_audits ORDER BY updated_at DESC,conversation_id DESC LIMIT ? OFFSET ?', [n + 1, off]);
    const items = (rows as Row[]).slice(0, n).map(head);
    return { items, has_more: rows.length > n, next_offset: rows.length > n ? off + n : null };
  }

  async detailForAdmin(conversationId: string, afterSequence = 0, limit = 100): Promise<Row | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_agent_conversation_audits WHERE conversation_id=?', [conversationId]);
    if (!rows[0]) return null;
    const n = Math.min(Math.max(Math.floor(limit) || 100, 1), 200);
    const after = Math.max(Math.floor(afterSequence) || 0, 0);
    const [members] = await this.pool.query('SELECT session_id,display_label,principal_json,on_behalf_of,confirmed_at FROM bz_agent_conversation_members WHERE conversation_id=? ORDER BY session_id', [conversationId]);
    const [rowsOfEvents] = await this.pool.query('SELECT * FROM bz_agent_conversation_events WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?', [conversationId, after, n + 1]);
    const events = (rowsOfEvents as Row[]).slice(0, n).map(eventView);
    return {
      conversation: head(rows[0]), members: (members as Row[]).map((member) => ({
        session_id: member.session_id, display_label: member.display_label, confirmed: Boolean(member.confirmed_at),
        ...(member.confirmed_at ? { principal: json(member.principal_json), on_behalf_of: member.on_behalf_of } : {}),
      })), events, has_more: rowsOfEvents.length > n,
      next_after_sequence: events.length ? events.at(-1)!.sequence : after,
    };
  }

  async findRunLinkForAdmin(runId: string): Promise<{ conversation_audit_id: string; client_turn_id: string } | null> {
    const [rows] = await this.pool.query("SELECT conversation_id,client_turn_id FROM bz_agent_conversation_events WHERE run_id=? AND kind='run_link' LIMIT 1", [runId]);
    return rows[0] ? { conversation_audit_id: String(rows[0].conversation_id), client_turn_id: String(rows[0].client_turn_id) } : null;
  }
}
