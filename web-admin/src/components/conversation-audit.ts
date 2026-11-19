type AuditTurnStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface AuditConversation {
  conversation_id: string;
  client_archive_id: string;
  client_conversation_id: string;
  client_app_id: string;
  route_key: string;
  state: 'enrolling' | 'ready';
  member_count: number;
  confirmed_count: number;
  last_sequence: number;
  message_count: number;
  turn_count: number;
  last_turn_status: AuditTurnStatus | null;
  first_user_preview?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditMember {
  session_id: string;
  display_label: string;
  confirmed: boolean;
  client_app_id?: string;
  client_name?: string;
  route_key?: string;
  principal: { id: string; tenant?: string; roles: string[] };
  on_behalf_of?: string;
}

/** The conversation header identifies its writer, not every member's business system. */
export function auditMemberContext(member: AuditMember | undefined, conversation: Pick<AuditConversation, 'client_app_id' | 'route_key'> | null): {
  systemLabel: string;
  routeLabel: string;
  source: 'member' | 'legacy_header' | 'unavailable';
} {
  if (!member) return { systemLabel: '未记录', routeLabel: '未记录', source: 'unavailable' };
  const hasMemberContext = [member.client_app_id, member.client_name, member.route_key].some(value => typeof value === 'string');
  if (!hasMemberContext && conversation) {
    return { systemLabel: conversation.client_app_id || '未记录', routeLabel: conversation.route_key || '未记录', source: 'legacy_header' };
  }
  const systemLabel = member.client_name && member.client_app_id
    ? `${member.client_name} · ${member.client_app_id}`
    : member.client_name || member.client_app_id || '未记录';
  return { systemLabel, routeLabel: member.route_key || '未记录', source: hasMemberContext ? 'member' : 'unavailable' };
}

export interface AuditEvent {
  event_id: string;
  sequence: number;
  client_turn_id: string;
  kind: 'turn_start' | 'user_message' | 'assistant_message' | 'run_link' | 'turn_end';
  content?: string;
  run_id?: string;
  member_session_id?: string;
  thread_id?: number;
  status?: AuditTurnStatus;
  created_at: string;
}

export interface AuditListPage {
  schema: string;
  items: AuditConversation[];
  has_more: boolean;
  next_offset: number | null;
}

export const conversationSources = {
  all: '全部渠道',
  client: '客户端',
  web: '网页助手',
  wecom: '企业微信',
  other: '其他接入',
} as const;
export type ConversationSource = keyof typeof conversationSources;
export function readConversationSource(value?: string): ConversationSource {
  return value && Object.hasOwn(conversationSources, value) ? value as ConversationSource : 'all';
}
export interface ConversationFeedItem {
  kind: 'audit' | 'thread';
  source: Exclude<ConversationSource, 'all'>;
  conversation_id: string | null;
  thread_id: number | null;
  title: string | null;
  source_label: string;
  route_key: string;
  updated_at: string;
  message_count: number;
  turn_count: number | null;
  last_turn_status: string | null;
  state: string | null;
  client_app_id: string | null;
  client_conversation_id: string | null;
}
export interface ConversationFeedPage {
  next_cursor?: string | null;
  items: ConversationFeedItem[];
  has_more: boolean;
  next_offset: number | null;
}
export function feedKey(item: ConversationFeedItem): string {
  return item.kind === 'audit' ? `audit:${item.conversation_id}` : `thread:${item.thread_id}`;
}
export function feedTitle(item: ConversationFeedItem): string {
  if (item.title?.trim()) return item.title.trim();
  const id = item.client_conversation_id || item.conversation_id || String(item.thread_id ?? '');
  return `${item.source_label || conversationSources[item.source]} · ${id.length > 12 ? '…' + id.slice(-12) : id}`;
}
interface ThreadTraceRef {
  job_id?: string | null;
  agent_run_id?: string | null;
}
export function traceKey(message: ThreadTraceRef): string {
  if (message.job_id) return `job:${message.job_id}`;
  return message.agent_run_id ? `agent-run:${message.agent_run_id}` : '';
}
/** Once per reference. An unanswered input stays traceable, then its reply takes over the link. */
export function threadTraceOwners(messages: ReadonlyArray<ThreadTraceRef & { id: number; direction: 'in' | 'out' }>): Set<number> {
  const owners = new Map<string, { id: number; direction: 'in' | 'out' }>();
  for (const message of messages) {
    const key = traceKey(message);
    if (!key) continue;
    const previous = owners.get(key);
    if (!previous || (previous.direction === 'in' && message.direction === 'out')) owners.set(key, message);
  }
  return new Set([...owners.values()].map(message => message.id));
}

export interface AuditDetailPage {
  schema: string;
  conversation: AuditConversation;
  members: AuditMember[];
  events: AuditEvent[];
  has_more: boolean;
  next_after_sequence: number | null;
}

export interface AuditTurn {
  id: string;
  sequence: number;
  events: AuditEvent[];
  messages: AuditEvent[];
  runs: AuditEvent[];
  start?: AuditEvent;
  end?: AuditEvent;
}

/** Events are immutable; repeated pages may fill gaps but cannot replace received text. */
export function mergeAuditEvents(current: readonly AuditEvent[], incoming: readonly AuditEvent[]): AuditEvent[] {
  const events = new Map<string, AuditEvent>();
  for (const event of [...current, ...incoming]) {
    const existing = events.get(event.event_id);
    if (!existing) {
      events.set(event.event_id, { ...event });
      continue;
    }
    const received = Object.fromEntries(Object.entries(existing).filter(([, value]) => value !== undefined));
    events.set(event.event_id, { ...event, ...received });
  }
  return [...events.values()].sort((left, right) => left.sequence - right.sequence ||
    (left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0));
}

/** Group the complete accumulated event list, including turns spanning multiple pages. */
export function groupAuditTurns(events: readonly AuditEvent[]): AuditTurn[] {
  const turns = new Map<string, AuditTurn>();
  for (const event of mergeAuditEvents([], events)) {
    let turn = turns.get(event.client_turn_id);
    if (!turn) {
      turn = { id: event.client_turn_id, sequence: event.sequence, events: [], messages: [], runs: [] };
      turns.set(event.client_turn_id, turn);
    }
    turn.events.push(event);
    if (event.kind === 'user_message' || event.kind === 'assistant_message') turn.messages.push(event);
    else if (event.kind === 'run_link') turn.runs.push(event);
    else if (event.kind === 'turn_start' && !turn.start) turn.start = event;
    else if (event.kind === 'turn_end') turn.end = event;
  }
  return [...turns.values()];
}

export function auditStatusLabel(status?: string | null): string {
  if (!status) return '—';
  const labels: Record<string, string> = {
    enrolling: '授权确认中',
    ready: '已就绪',
    running: '进行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    executed: '执行成功',
    business_rejected: '业务拒绝',
    awaiting_approval: '等待审批',
    denied: '审批拒绝',
    rejected_before_dispatch: '派发前拦截',
    reconciliation_required: '需要人工对账',
    in_progress: '执行中',
    preparing: '准备中',
    context_ready: '上下文已就绪',
  };
  return Object.hasOwn(labels, status) ? labels[status] : status;
}
