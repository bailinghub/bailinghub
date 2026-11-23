<template>
  <div class="auditConvo" :class="{ hasSelection: !!selectedId || !!channelThread }">
    <aside ref="rail" class="auditRail" aria-label="会话列表">
      <div class="railHeading">
        <div class="headingLine"><h3>最近会话</h3><el-select :model-value="activeSource" class="sourceFilter" aria-label="会话来源" size="small" @change="emit('change-source', $event)">
          <el-option v-for="(label, key) in conversationSources" :key="key" :value="key" :label="label" />
        </el-select></div>
        <el-input v-model="query" clearable :prefix-icon="Search" aria-label="筛选已加载的会话" placeholder="筛选已加载的会话或编号" />
      </div>
      <div v-if="legacyFeed" class="legacyFeed muted">当前存储仅提供客户端会话列表，其他记录可从下方入口查看。</div>
      <div v-loading="listLoading" class="conversationList">
        <el-alert v-if="listError" :title="listError" type="error" :closable="false" />
        <el-empty v-else-if="!listLoading && !visibleConversations.length" :image-size="48"
          :description="query.trim() ? '已加载的会话中没有匹配项' : '该渠道暂无已记录的会话'" />
        <button v-for="item in visibleConversations" :key="feedKey(item)" type="button" class="conversationItem"
          :aria-current="currentKey === feedKey(item) ? 'true' : undefined" @click="selectFeedItem(item)">
          <span class="itemTop"><ConversationSourceTag :source="item.source" /><time class="muted">{{ fmtTime(item.updated_at) }}</time></span>
          <strong class="itemTitle" :title="feedTitle(item)">{{ feedTitle(item) }}</strong>
          <span class="itemMeta muted">
            <span v-if="item.source_label && item.source_label !== conversationSources[item.source]" class="itemOrigin" :title="item.source_label">{{ item.source_label }}</span>
            <span class="itemState">{{ item.turn_count != null ? `${item.turn_count} 轮 · ` : '' }}{{ item.message_count }} 条消息</span>
          </span>
          <span v-if="item.kind === 'audit' && ((item.state && item.state !== 'ready') || (item.last_turn_status && item.last_turn_status !== 'completed'))" class="itemState">
            {{ item.state && item.state !== 'ready' ? auditStatusLabel(item.state) : turnStatusLabel(item.last_turn_status) }}
          </span>
        </button>
        <div v-if="listMore" class="pager"><el-button link :loading="listMoreLoading" @click="loadMoreConversations">加载更多对话</el-button></div>
      </div>
      <button class="directoryEntry" type="button" @click="emit('open-directory')">
        <el-icon><Collection /></el-icon><span>授权与接入记录</span><el-icon><ArrowRight /></el-icon>
      </button>
    </aside>

    <main v-if="currentThreadId" class="channelMain" aria-label="渠道会话详情">
      <el-button class="backToList" link @click="emit('back-list')"><el-icon><ArrowLeft /></el-icon>最近会话</el-button>
      <ChannelThread ref="channelPane" feed :thread-id="currentThreadId" :heading="selectedThread?.title || ''" :source="selectedThread?.source" @open-job="emit('open-job', $event)" @open-audit="(id, turn) => emit('open-audit', id, turn)" />
    </main>
    <main v-else ref="pane" v-loading="detailLoading" class="auditPane" aria-label="客户端对话正文与授权执行">
      <el-button class="backToList" link @click="emit('back-list')"><el-icon><ArrowLeft /></el-icon>最近会话</el-button>
      <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" class="notice" />
      <el-empty v-if="!conversation && !detailLoading && !detailError" :image-size="70" description="选择一条会话，查看对话与执行记录" />
      <template v-if="conversation">
        <header class="conversationHeader" data-reading-header>
          <div class="detailTitle"><ConversationSourceTag source="client" /><h2 :title="conversationTitle(conversation)">{{ conversationTitle(conversation) }}</h2></div>
          <div class="headerMeta muted">{{ conversation.client_app_id }} · 最近更新 {{ fmtTime(conversation.updated_at, true) }} · 已接收 {{ conversation.turn_count }} 轮 / {{ conversation.message_count }} 条消息</div>
          <div class="headerLinks">
            <el-button link type="primary" @click="infoPanel = 'members'">关联授权（{{ conversation.member_count }}）</el-button>
            <el-button link @click="infoPanel = 'archive'">归档信息</el-button>
          </div>
        </header>
        <el-alert v-if="conversation.state !== 'ready'" title="授权成员尚未全部确认，对话归档尚未就绪。" type="warning" :closable="false" class="notice" />
        <el-alert v-if="focusTurn && !turns.some(turn => turn.id === focusTurn)" :title="hasMore ? '目标轮次尚未加载，请继续加载后续记录。' : '当前已接收的记录中没有目标轮次。'" type="info" :closable="false" class="notice" />
        <el-empty v-if="!turns.length && !detailLoading" :image-size="48" description="尚未收到客户端正文或轮次记录" />
        <div v-if="beforeSequence != null" class="historyControl"><el-button link :loading="moreLoading" :disabled="detailLoading" @click="loadEarlierEvents">加载更早记录</el-button></div>
        <section v-for="(turn, index) in turns" :key="turn.id" :data-turn-id="turn.id" class="auditTurn" :class="{ focused: focusTurn === turn.id }">
          <div class="turnHeading"><h3 :title="turn.id">{{ beforeSequence == null ? `第 ${index + 1} 轮` : ('轮次 · ' + turn.id.slice(-8)) }}</h3>
            <span class="muted" :class="{ attention: turn.end?.status === 'failed' }">{{ turn.end ? turnStatusLabel(turn.end.status) : beforeSequence != null && !turn.start ? '部分轮次记录' : '尚未收到轮次结束记录' }}</span>
            <time class="muted">{{ fmtTime(turn.start?.created_at || turn.events[0]?.created_at, true) }}</time>
          </div>
          <div v-if="!turn.messages.some(message => message.kind === 'user_message')" class="missingText">{{ beforeSequence != null && !turn.start ? '本轮此前的内容可向前加载。' : '本轮尚未收到用户正文。' }}</div>
          <article v-for="event in turn.messages" :key="event.event_id" :data-reading-id="event.event_id" class="auditMessage" :class="event.kind === 'user_message' ? 'userMessage' : 'assistantMessage'">
            <span class="messageMeta"><strong class="actorName"><el-icon aria-hidden="true"><User v-if="event.kind === 'user_message'" /><ChatLineSquare v-else /></el-icon>{{ event.kind === 'user_message' ? '用户' : '客户端助手' }}</strong><time :datetime="event.created_at" :title="fmtTime(event.created_at, true)">{{ fmtTime(event.created_at, true).split(' ').pop() }}</time></span>
            <div v-if="typeof event.content === 'string'" class="messageText">{{ event.content || '（空消息）' }}</div>
            <div v-else class="messageText missingText">正文未上传或已不可用。</div>
          </article>
          <div v-if="turn.end && (beforeSequence == null || turn.start) && !turn.messages.some(message => message.kind === 'assistant_message')" class="missingText">本轮已结束，但未收到客户端助手正文。</div>

          <div v-if="turn.runs.length" class="authorizationRuns">
            <article v-for="run in turn.runs" :key="run.event_id" class="authorizationRun" :data-run-id="run.run_id" :data-reading-id="run.event_id">
              <div class="runHead">
                <button v-if="run.run_id && run.thread_id" type="button" class="runToggle" :aria-expanded="!!runTraces[run.run_id]?.open"
                  @click="toggleRunTrace(run)">
                  <el-icon><ArrowDown v-if="runTraces[run.run_id]?.open" /><ArrowRight v-else /></el-icon>
                  <span class="muted">授权执行</span><strong>{{ memberLabel(run.member_session_id) }}</strong>
                  <span class="runState" :class="'state-' + (runSummaries[run.run_id]?.type || 'info')">{{ runSummaries[run.run_id]?.label || '查看轨迹' }}</span>
                </button>
                <span v-else class="unlinkedRun"><span class="muted">授权执行</span> {{ memberLabel(run.member_session_id) }}</span>
              </div>
              <p v-if="!run.thread_id" class="missingText">缺少原授权记录关联，无法打开执行轨迹。</p>
              <div v-if="!run.thread_id || !run.run_id || runTraces[run.run_id]?.open" class="runTrace">
                <div class="runActions">
                  <el-button v-if="run.thread_id" link type="primary" @click="emit('open-thread', run.thread_id)">原授权记录</el-button>
                  <details class="inlineMeta"><summary>执行标识</summary><div class="muted">系统：{{ memberContext(run.member_session_id).systemLabel }} · 路由：{{ memberContext(run.member_session_id).routeLabel }}</div>
                    <div class="mono">Session：{{ run.member_session_id || '未记录' }}</div><div class="mono">Run：{{ run.run_id || '未记录' }}</div><div class="mono">轮次：{{ turn.id }}</div>
                  </details>
                </div>
                <div v-if="memberContext(run.member_session_id).source === 'legacy_header'" class="missingText">旧记录：仅有归档头部信息，未单独记录成员系统与路由。</div>
                <div v-else-if="memberContext(run.member_session_id).source === 'unavailable'" class="missingText">缺少授权成员的系统与路由信息，保留原执行关联。</div>
                <span v-if="run.run_id && runTraces[run.run_id]?.loading" class="muted" role="status">正在读取执行轨迹…</span>
                <el-alert v-if="run.run_id && runTraces[run.run_id]?.error" :title="runTraces[run.run_id].error" type="error" :closable="false" />
                <template v-if="run.run_id && runTraces[run.run_id]?.data">
                  <el-alert v-if="runTraces[run.run_id].data?.trace.summary?.partial" title="当前只显示部分工具轨迹，可继续查看原授权记录。" type="warning" :closable="false" />
                  <div v-for="invocation in runTraces[run.run_id].data?.invocations" :key="invocation.job_id" class="invocation">
                    <b class="mono">{{ invocation.tool }}</b><span>{{ invocationStatus(invocation) }}</span><el-button link type="primary" size="small" @click="emit('open-job', invocation.job_id)">工具详情</el-button>
                  </div>
                  <el-timeline v-if="runTraces[run.run_id].data?.trace.events.length" class="executionTimeline">
                    <el-timeline-item v-for="(event, eventIndex) in runTraces[run.run_id].data?.trace.events" :key="eventIndex" :timestamp="fmtTime(event.ts, true)" placement="top">
                      <b>{{ event.title || event.event }}</b><div v-if="event.summary" class="muted">{{ event.summary }}</div>
                      <el-collapse v-if="event.detail && Object.keys(event.detail).length"><el-collapse-item title="事件详情"><pre class="eventDetail">{{ JSON.stringify(event.detail, null, 2) }}</pre></el-collapse-item></el-collapse>
                    </el-timeline-item>
                  </el-timeline>
                  <p v-else class="muted">该授权尚无可展示的执行事件。</p>
                </template>
              </div>
            </article>
          </div>
          <p v-else-if="beforeSequence == null || turn.start" class="muted noRuns">本轮尚无已关联的授权执行记录。</p>
          <details v-if="!turn.runs.length" class="inlineMeta"><summary>轮次标识</summary><span class="mono">{{ turn.id }}</span></details>
        </section>
        <footer class="pager muted">已加载 {{ turns.length }} 轮、{{ loadedMessageCount }} 条消息（{{ events.length }} 条归档事件）<span v-if="!hasMore && beforeSequence == null"> · 旧历史或未同步内容可能缺失</span>
          <div v-if="hasMore"><el-button :loading="moreLoading" @click="loadMoreEvents">加载后续记录</el-button></div>
        </footer>
      </template>
    </main>
    <el-drawer :model-value="!!infoPanel" :title="infoPanel === 'members' ? '关联授权' : '归档信息'" size="min(480px, 96vw)" append-to-body @update:model-value="infoPanel = null">
      <template v-if="conversation">
        <div v-if="infoPanel === 'members'">
          <p>已确认 {{ conversation.confirmed_count }} / {{ conversation.member_count }} 项授权</p>
          <article v-for="member in memberCards" :key="member.session_id" class="memberCard" :data-member-session-id="member.session_id">
            <h3>{{ member.display_label || '未命名授权' }} <span class="muted">{{ member.confirmed ? '已确认' : '待确认' }}</span></h3>
            <dl class="facts"><dt>系统</dt><dd>{{ member.context.systemLabel }}</dd><dt>路由</dt><dd>{{ member.context.routeLabel }}</dd><dt>Session</dt><dd class="mono">{{ member.session_id }}</dd></dl>
            <p v-if="member.context.source === 'legacy_header'" class="missingText">旧记录：仅有归档头部信息，未单独记录成员系统与路由。</p>
          </article>
        </div>
        <dl v-else class="facts"><dt>归档写入方</dt><dd>{{ conversation.client_app_id }}</dd><dt>写入路由</dt><dd>{{ conversation.route_key }}</dd>
          <dt>客户端会话 ID</dt><dd class="mono">{{ conversation.client_conversation_id }}</dd><dt>客户端归档 ID</dt><dd class="mono">{{ conversation.client_archive_id || '未记录' }}</dd><dt>归档记录 ID</dt><dd class="mono">{{ conversation.conversation_id }}</dd>
          <dt>归档状态</dt><dd>{{ auditStatusLabel(conversation.state) }}</dd><dt>最近更新</dt><dd>{{ fmtTime(conversation.updated_at, true) }}</dd>
        </dl>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ArrowDown, ArrowLeft, ArrowRight, Collection, Search, User, ChatLineSquare } from '@element-plus/icons-vue';
import { api } from '../request';
import { fmtTime } from '../util';
import ChannelThread from './ChannelThread.vue';
import ConversationSourceTag from './ConversationSourceTag.vue';
import { readingPosition, restoreReadingPosition } from './conversation-reading-position';
import { auditMemberContext, auditStatusLabel, groupAuditTurns, mergeAuditEvents, conversationSources, feedKey, feedTitle, readConversationSource } from './conversation-audit';
import type { AuditConversation, AuditMember, AuditEvent, AuditListPage, AuditDetailPage, ConversationFeedItem, ConversationFeedPage, ConversationSource } from './conversation-audit';

const props = defineProps<{ selectedId?: string; focusTurn?: string; channelThread?: number; source?: string }>();
const emit = defineEmits<{ select: [id: string]; 'select-channel': [id: number]; 'change-source': [source: ConversationSource]; 'open-audit': [id: string, turn?: string]; 'back-list': []; 'open-directory': []; 'open-thread': [id: number]; 'open-job': [id: string] }>();
interface Invocation { job_id: string; tool: string; state?: string | null; status: string; approval_status?: string | null }
interface RunTrace {
  run: { status: string };
  trace: { summary?: { partial?: boolean }; events: Array<{ ts: string; event: string; title?: string; summary?: string; detail?: Record<string, unknown> }> };
  invocations: Invocation[];
}
interface RunTraceState { loading: boolean; open: boolean; data: RunTrace | null; error: string }
const LIST_PAGE = 50, EVENT_PAGE = 100;
const conversations = ref<ConversationFeedItem[]>([]), listLoading = ref(false), listMoreLoading = ref(false), listMore = ref(false), listOffset = ref<number | null>(0), listError = ref('');
const query = ref('');
const activeSource = computed(() => readConversationSource(props.source));
const legacyFeed = ref(false);
const listCursor = ref<string | null>(null);
const channelPane = ref<InstanceType<typeof ChannelThread> | null>(null);
const currentThreadId = ref<number | null>(null);
const currentKey = computed(() => currentThreadId.value ? `thread:${currentThreadId.value}` : `audit:${currentId.value}`);
const selectedThread = computed(() => conversations.value.find(item => item.kind === 'thread' && item.thread_id === currentThreadId.value));
const rail = ref<HTMLElement | null>(null);
const infoPanel = ref<'archive' | 'members' | null>(null);
const currentId = ref(''), conversation = ref<AuditConversation | null>(null), members = ref<AuditMember[]>([]), events = ref<AuditEvent[]>([]);
const detailLoading = ref(false), moreLoading = ref(false), hasMore = ref(false), afterSequence = ref<number | null>(0), detailError = ref(''), pane = ref<HTMLElement | null>(null);
const beforeSequence = ref<number | null>(null);
const runTraces = reactive<Record<string, RunTraceState>>({});
let listGeneration = 0, detailGeneration = 0;
const turns = computed(() => groupAuditTurns(events.value));
const memberCards = computed(() => members.value.map(member => ({ ...member, context: auditMemberContext(member, conversation.value) })));
const loadedMessageCount = computed(() => events.value.filter(event => event.kind === 'user_message' || event.kind === 'assistant_message').length);
function conversationTitle(item: AuditConversation): string {
  if (item.first_user_preview?.trim()) return item.first_user_preview.trim();
  const id = item.client_conversation_id;
  return `${item.client_app_id} · ${id.length > 12 ? '…' + id.slice(-12) : id}`;
}
const visibleConversations = computed(() => {
  const text = query.value.trim().toLowerCase();
  if (!text) return conversations.value;
  return conversations.value.filter(item =>
    [item.title, item.source_label, conversationSources[item.source], String(item.thread_id ?? ''), item.client_conversation_id, item.conversation_id, item.client_app_id, item.route_key]
      .some(value => value?.toLowerCase().includes(text)));
});
function statusType(status?: string | null): 'info' | 'success' | 'warning' | 'danger' {
  if (status === 'completed' || status === 'executed' || status === 'ready') return 'success';
  if (status === 'failed' || status === 'denied' || status === 'business_rejected') return 'danger';
  if (status === 'running' || status === 'awaiting_approval') return 'warning';
  return 'info';
}
function memberLabel(sessionId?: string): string { return members.value.find(member => member.session_id === sessionId)?.display_label || '未识别授权（保留原执行关联）'; }
function memberContext(sessionId?: string) { return memberCards.value.find(member => member.session_id === sessionId)?.context || auditMemberContext(undefined, conversation.value); }
function turnStatusLabel(status?: string | null): string {
  if (status === 'completed') return '本轮已结束';
  if (status === 'failed') return '本轮失败';
  if (status === 'cancelled') return '本轮已取消';
  return auditStatusLabel(status);
}
function invocationStatus(invocation: Invocation): string {
  if (invocation.approval_status === 'pending') return '等待审批';
  if (invocation.approval_status === 'denied') return '审批拒绝';
  if (invocation.approval_status === 'approved' && invocation.state === 'awaiting_approval') return '已批准，等待客户端续执行';
  return auditStatusLabel(invocation.state || invocation.status);
}
const runSummaries = computed(() => Object.fromEntries(
  Object.entries(runTraces).map(([id, state]) => [id, summarizeTrace(state)]),
));
function summarizeTrace(state: RunTraceState): { label: string; type: string } {
  if (state.loading) return { label: '读取中…', type: 'info' };
  const trace = state.data;
  if (!trace) return { label: '读取失败', type: 'danger' };
  if (trace.trace.summary?.partial) return { label: '部分轨迹', type: 'warning' };
  if (trace.invocations.length === 1) {
    const inv = trace.invocations[0];
    const state = inv.approval_status === 'pending' ? 'awaiting_approval' : inv.approval_status === 'denied' ? 'denied' : inv.state || inv.status;
    return { label: invocationStatus(inv), type: statusType(state) };
  }
  if (trace.invocations.length > 1) {
    const pending = trace.invocations.filter(inv => inv.approval_status === 'pending').length;
    return pending ? { label: `${pending} 项等待审批`, type: 'warning' }
      : { label: `${trace.invocations.length} 项工具调用`, type: 'info' };
  }
  return { label: '运行：' + auditStatusLabel(trace.run.status), type: 'info' };
}
async function fetchFeed(offset: number, source: ConversationSource, cursor?: string | null): Promise<ConversationFeedPage & { legacy?: boolean }> {
  const params = new URLSearchParams({ source, limit: String(LIST_PAGE) });
  if (cursor) params.set('cursor', cursor);
  else params.set('offset', String(offset));
  try { return await api<ConversationFeedPage>('/admin/api/conversation-audits/feed?' + params); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'conversation_feed_unavailable') throw error;
    if (source !== 'all' && source !== 'client') throw new Error('当前存储未提供此渠道的会话列表，请打开下方“授权与接入记录”。');
    const page = await api<AuditListPage>(`/admin/api/conversation-audits?limit=${LIST_PAGE}&offset=${offset}`);
    return { ...page, legacy: true, items: page.items.map(row => ({ ...row, kind: 'audit', source: 'client', thread_id: null, title: row.first_user_preview || null, source_label: row.client_app_id })) };
  }
}
function selectFeedItem(item: ConversationFeedItem): void {
  if (feedKey(item) === currentKey.value && !props.focusTurn) {
    if (item.kind === 'thread') channelPane.value?.scrollToLatest();
    else restoreReadingPosition(pane.value, null, true);
  }
  if (item.kind === 'audit' && item.conversation_id) emit('select', item.conversation_id);
  else if (item.kind === 'thread' && item.thread_id) emit('select-channel', item.thread_id);
}
function openFeedItem(item: ConversationFeedItem): void {
  if (item.kind === 'thread' && item.thread_id) showChannel(item.thread_id);
  else if (item.kind === 'audit' && item.conversation_id) void openConversation(item.conversation_id);
}
function showChannel(id: number): void {
  if (currentThreadId.value === id) return;
  resetSelection();
  currentThreadId.value = id;
}
function resetSelection(): void {
  ++detailGeneration;
  currentThreadId.value = null; currentId.value = ''; conversation.value = null; infoPanel.value = null;
  events.value = []; members.value = []; hasMore.value = false; afterSequence.value = 0; beforeSequence.value = null;
  detailError.value = ''; detailLoading.value = false; moreLoading.value = false;
  for (const key of Object.keys(runTraces)) delete runTraces[key];
}
async function loadConversations(): Promise<void> {
  const generation = ++listGeneration;
  listLoading.value = true; listError.value = ''; listMoreLoading.value = false;
  try {
    const page = await fetchFeed(0, activeSource.value);
    if (generation !== listGeneration) return;
    legacyFeed.value = !!page.legacy; conversations.value = page.items; listMore.value = page.has_more; listOffset.value = page.next_offset; listCursor.value = page.next_cursor ?? null;
    if (!props.selectedId && !props.channelThread && !currentId.value && !currentThreadId.value && page.items.length && window.matchMedia('(min-width: 901px)').matches) {
      openFeedItem(page.items[0]);
    }
  } catch (error) { if (generation === listGeneration) listError.value = (error as Error).message; }
  finally { if (generation === listGeneration) listLoading.value = false; }
}
async function loadMoreConversations(): Promise<void> {
  if (listLoading.value || listMoreLoading.value || !listMore.value || (!listCursor.value && listOffset.value == null)) return;
  const generation = listGeneration;
  listMoreLoading.value = true;
  try {
    const page = await fetchFeed(listOffset.value ?? conversations.value.length, activeSource.value, listCursor.value);
    if (generation !== listGeneration) return;
    const rows = new Map(conversations.value.map(item => [feedKey(item), item]));
    for (const item of page.items) rows.set(feedKey(item), item);
    conversations.value = [...rows.values()]; listMore.value = page.has_more; listOffset.value = page.next_offset; listCursor.value = page.next_cursor ?? null; listError.value = '';
  } catch (error) { if (generation === listGeneration) listError.value = (error as Error).message; }
  finally { if (generation === listGeneration) listMoreLoading.value = false; }
}
function applyPage(page: AuditDetailPage): void {
  conversation.value = page.conversation; members.value = page.members;
  events.value = mergeAuditEvents(events.value, page.events); hasMore.value = page.has_more === true; afterSequence.value = page.next_after_sequence ?? null;
}
async function focusLoadedTurn(): Promise<void> {
  if (!props.focusTurn) return;
  await nextTick();
  const target = [...(pane.value?.querySelectorAll<HTMLElement>('[data-turn-id]') ?? [])].find(element => element.dataset.turnId === props.focusTurn);
  if (target && pane.value) {
    const header = pane.value.querySelector('header');
    pane.value.scrollTop += target.getBoundingClientRect().top - pane.value.getBoundingClientRect().top - (header?.clientHeight ?? 0) - 10;
  }
}
function readEvents(id: string, query: string) {
  return api<AuditDetailPage>(`/admin/api/conversation-audits/${encodeURIComponent(id)}?${query}&limit=${EVENT_PAGE}`);
}
function priorCursor(page: AuditDetailPage): number | null {
  return page.has_earlier && page.next_before_sequence != null ? page.next_before_sequence : null;
}
async function openConversation(id: string, locate = false): Promise<void> {
  const generation = ++detailGeneration;
  const same = currentId.value === id && !!conversation.value;
  const firstLoaded = same && !locate ? events.value[0]?.sequence : undefined;
  const lastLoaded = same && !locate ? events.value.at(-1)?.sequence : undefined;
  currentThreadId.value = null; currentId.value = id;
  if (!same) {
    conversation.value = null; events.value = []; members.value = []; hasMore.value = false; afterSequence.value = 0;
    beforeSequence.value = null; infoPanel.value = null;
  }
  detailLoading.value = true; moreLoading.value = false; detailError.value = '';
  for (const [key, state] of Object.entries(runTraces)) {
    if (!same || state.loading) delete runTraces[key];
  }
  try {
    const target = props.focusTurn;
    let page = await readEvents(id, target ? 'after_sequence=0' : 'tail=1');
    if (generation !== detailGeneration) return;
    let before = priorCursor(page);
    let windowEvents = page.events;
    // Keep the history already opened by the reader when refreshing the newest page.
    while (!target && firstLoaded != null && before != null && before > firstLoaded) {
      const older = await readEvents(id, 'before_sequence=' + before);
      if (generation !== detailGeneration) return;
      const next = priorCursor(older);
      if (next != null && next >= before) throw new Error('归档分页位置未能核对');
      windowEvents = [...older.events, ...windowEvents];
      before = next;
    }
    if (target) {
      // Trace links open at their turn. Refreshing the same link keeps later pages the reader already opened.
      let found = windowEvents.some(event => event.client_turn_id === target);
      while (page.has_more && (!found || (lastLoaded != null && (windowEvents.at(-1)?.sequence ?? 0) < lastLoaded))) {
        const cursor = page.next_after_sequence;
        if (cursor == null) throw new Error('归档分页位置未能核对');
        page = await readEvents(id, 'after_sequence=' + cursor);
        if (generation !== detailGeneration) return;
        if (page.has_more && (page.next_after_sequence == null || page.next_after_sequence <= cursor)) throw new Error('归档分页位置未能核对');
        windowEvents = windowEvents.concat(page.events);
        found ||= page.events.some(event => event.client_turn_id === target);
      }
    }
    const position = same && !locate ? readingPosition(pane.value) : null;
    events.value = [];
    applyPage({ ...page, events: windowEvents }); beforeSequence.value = before;
    await nextTick();
    if (generation !== detailGeneration) return;
    if (target && (locate || !same)) await focusLoadedTurn();
    else restoreReadingPosition(pane.value, position, true);
  } catch (error) {
    if (generation === detailGeneration) detailError.value = (same ? '刷新未成功，以下为上次读取的记录。' : '') + (error as Error).message;
  } finally { if (generation === detailGeneration) detailLoading.value = false; }
}
async function loadEarlierEvents(): Promise<void> {
  const before = beforeSequence.value;
  if (!currentId.value || detailLoading.value || moreLoading.value || before == null) return;
  const generation = detailGeneration;
  moreLoading.value = true; detailError.value = '';
  try {
    const page = await readEvents(currentId.value, 'before_sequence=' + before);
    if (generation !== detailGeneration) return;
    const cursor = priorCursor(page);
    if (cursor != null && cursor >= before) throw new Error('归档分页位置未能核对');
    const position = readingPosition(pane.value);
    events.value = mergeAuditEvents(events.value, page.events);
    beforeSequence.value = cursor;
    await nextTick();
    if (generation === detailGeneration) restoreReadingPosition(pane.value, position, false);
  } catch (error) { if (generation === detailGeneration) detailError.value = (error as Error).message; }
  finally { if (generation === detailGeneration) moreLoading.value = false; }
}
async function loadMoreEvents(): Promise<void> {
  if (!currentId.value || detailLoading.value || moreLoading.value || !hasMore.value || afterSequence.value == null) return;
  const generation = detailGeneration;
  moreLoading.value = true; detailError.value = '';
  try {
    const page = await readEvents(currentId.value, 'after_sequence=' + afterSequence.value);
    if (generation === detailGeneration) applyPage(page);
  } catch (error) { if (generation === detailGeneration) detailError.value = (error as Error).message; }
  finally { if (generation === detailGeneration) moreLoading.value = false; }
}
async function toggleRunTrace(run: AuditEvent): Promise<void> {
  if (!run.run_id || !run.thread_id) return;
  const existing = runTraces[run.run_id];
  if (existing?.loading) { existing.open = !existing.open; return; }
  if (existing?.open) { existing.open = false; return; }
  if (existing?.data) { existing.open = true; return; }
  const generation = detailGeneration, id = run.run_id;
  runTraces[id] = { loading: true, open: true, data: null, error: '' };
  try {
    const data = await api<RunTrace>(`/admin/api/threads/${run.thread_id}/agent-runs/${encodeURIComponent(id)}/trace`);
    if (generation === detailGeneration) runTraces[id] = { loading: false, open: runTraces[id]?.open ?? true, data, error: '' };
  } catch (error) { if (generation === detailGeneration) runTraces[id] = { loading: false, open: runTraces[id]?.open ?? true, data: null, error: `授权轨迹未能读取：${(error as Error).message}` }; }
}
async function refresh(): Promise<void> {
  await Promise.all([loadConversations(), currentThreadId.value ? channelPane.value?.refresh() : currentId.value ? openConversation(currentId.value) : undefined]);
}
watch(() => [props.selectedId, props.channelThread, activeSource.value, props.focusTurn] as const, async ([id, thread, source, turn], previous) => {
  const changedSource = !!previous && previous[2] !== source;
  if (changedSource) {
    resetSelection(); conversations.value = []; listMore.value = false; listOffset.value = 0; listCursor.value = null; legacyFeed.value = false; query.value = '';
    void loadConversations();
  }
  if (id && (id !== currentId.value || turn !== previous?.[3])) await openConversation(id, true);
  else if (thread) showChannel(thread);
  else if (!id && !thread && previous && (previous[0] || previous[1]) && !changedSource) {
    infoPanel.value = null;
    await nextTick();
    if (window.matchMedia('(max-width: 900px)').matches) {
      const target = rail.value?.querySelector<HTMLElement>('[aria-current="true"]') || rail.value?.querySelector<HTMLInputElement>('input');
      target?.focus({ preventScroll: true });
    }
  }
}, { immediate: true });
onBeforeUnmount(() => { ++detailGeneration; ++listGeneration; });
onMounted(() => { void loadConversations(); });
defineExpose({ refresh });
</script>

<style scoped>
.auditConvo { display: grid; grid-template-columns: clamp(235px, 22vw, 310px) minmax(0, 1fr); height: max(480px, calc(100dvh - 258px)); border: 1px solid var(--el-border-color); }
h2, h3, p { margin: 0; }
h2 { font-size: 19px; line-height: 1.5; overflow-wrap: anywhere; }
h3 { font-size: 14px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono); overflow-wrap: anywhere; }
.auditRail { min-width: 0; min-height: 0; display: flex; flex-direction: column; border-right: 1px solid var(--el-border-color); }
.railHeading { padding: 14px 14px 12px; }
.headingLine, .itemMeta, .turnHeading, .runHead, .runActions, .headerLinks, .invocation { display: flex; align-items: center; gap: 8px; }
.sourceFilter { width: 99px; }
.channelMain { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.legacyFeed { padding: 2px 14px 8px; }
.headingLine { justify-content: space-between; margin-bottom: 9px; }
.conversationList { flex: 1; overflow: auto; }
.conversationItem, .directoryEntry, .runToggle { font: inherit; color: inherit; text-align: left; background: transparent; border: 0; cursor: pointer; }
.conversationItem { width: 100%; display: block; padding: 12px 14px; border-bottom: 1px solid var(--el-border-color-lighter); }
.conversationItem:hover, .directoryEntry:hover, .runToggle:hover { background: var(--el-fill-color-light); }
.conversationItem[aria-current=true] { background: var(--el-color-primary-light-9); }
.conversationItem[aria-current=true] .itemTitle { color: var(--el-color-primary); }
.conversationItem:focus-visible, .directoryEntry:focus-visible, .runToggle:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
.itemTitle { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; font-size: 14px; }
.itemTop, .detailTitle { display: flex; align-items: center; gap: 8px; }
.itemTop { justify-content: space-between; margin-bottom: 5px; }
.itemMeta { margin-top: 4px; }
.itemState { flex-shrink: 0; }
.itemMeta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
time { flex-shrink: 0; font-variant-numeric: tabular-nums; }
.itemState { font-size: 12px; color: var(--el-text-color-secondary); }
.directoryEntry { width: 100%; display: flex; align-items: center; gap: 8px; padding: 13px 14px; font-weight: 600; border-top: 1px solid var(--el-border-color); }
.directoryEntry .el-icon:last-child { margin-left: auto; }
.auditPane { --pane-inset: clamp(16px, 2vw, 32px); min-width: 0; overflow: auto; padding: 0 var(--pane-inset); }
.backToList { display: none; }
.conversationHeader { position: sticky; top: 0; z-index: 1; background: var(--el-bg-color); padding: 12px var(--pane-inset) 9px; margin-inline: calc(-1 * var(--pane-inset)); border-bottom: 1px solid var(--el-border-color); }
.headerMeta { margin: 5px 0; overflow-wrap: anywhere; }
.headerLinks, .runActions, .invocation { flex-wrap: wrap; }
.headerLinks .el-button + .el-button { margin-left: 4px; }
.auditTurn { padding: 16px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.auditTurn.focused .turnHeading h3 { color: var(--el-color-primary); }
.turnHeading { flex-wrap: wrap; margin-bottom: 10px; }
.turnHeading time { margin-left: auto; }
.detailTitle h2 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.historyControl { text-align: center; padding: 6px; }
.auditMessage { width: fit-content; max-width: 88%; margin-block: 10px; }
.userMessage { margin-left: auto; }
.messageMeta, .actorName { display: flex; align-items: center; gap: 5px; }
.messageMeta { gap: 9px; margin-bottom: 4px; }
.userMessage .messageMeta { justify-content: flex-end; }
.actorName { font-size: 12px; color: var(--el-text-color-primary); }
.messageMeta time { font-size: 11px; color: var(--el-text-color-secondary); }
.messageText { border: 1px solid var(--el-border-color-lighter); background: var(--el-fill-color-light); padding: 8px 12px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.65; }
.userMessage .messageText { background: var(--el-color-primary-light-9); border-color: var(--el-color-primary-light-7); }
.authorizationRuns { margin: 12px 0 0; }
.authorizationRun { border: 1px solid var(--el-border-color); }
.authorizationRun + .authorizationRun { margin-top: 6px; }
.runHead { background: var(--el-fill-color-lighter); }
.runToggle, .unlinkedRun { min-width: 0; flex: 1; display: flex; align-items: baseline; gap: 8px; padding: 9px 10px; font-size: 13px; overflow-wrap: anywhere; }
.runToggle .el-icon { align-self: center; }
.runToggle .muted { flex-shrink: 0; }
.runState { margin-left: auto; align-self: center; flex-shrink: 0; font-size: 12px; }
.state-success { color: var(--el-color-success); }
.state-warning, .missingText { color: var(--el-color-warning); }
.state-danger, .attention { color: var(--el-color-danger); }
.state-info { color: var(--el-text-color-secondary); }
.missingText, .noRuns { font-size: 12px; padding: 5px 0; }
.authorizationRun > .missingText { padding: 5px 10px; }
.runTrace { padding: 10px; border-top: 1px solid var(--el-border-color-lighter); }
.runActions { align-items: baseline; gap: 8px 18px; }
.inlineMeta { color: var(--el-text-color-secondary); font-size: 12px; overflow-wrap: anywhere; }
.inlineMeta summary { cursor: pointer; }
.inlineMeta[open] > summary { margin-bottom: 5px; }
.invocation { padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.invocation .el-button { margin-left: auto; }
.executionTimeline { margin: 10px 0; padding-left: 12px; }
.eventDetail { white-space: pre-wrap; overflow-wrap: anywhere; }
.pager { text-align: center; padding: 12px; }
.pager .el-button { margin-top: 4px; }
.notice { margin: 8px 0; }
.memberCard { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--el-border-color); }
.facts { display: grid; grid-template-columns: max-content minmax(0,1fr); gap: 10px 14px; margin: 12px 0; }
.facts dt { color: var(--el-text-color-secondary); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 900px) {
  .auditConvo { display: flex; flex-direction: column; min-width: 0; }
  .auditRail, .auditPane { height: 100%; border-right: 0; }
  .auditConvo.hasSelection .auditRail, .auditConvo:not(.hasSelection) .auditPane, .auditConvo:not(.hasSelection) .channelMain { display: none; }
  .channelMain { flex: 1; }
  .backToList { display: inline-flex; margin-top: 10px; }
  .conversationHeader { padding-top: 6px; }
  .auditPane { --pane-inset: 12px; }
  .authorizationRuns { margin-left: 0; }
}
@media (max-width: 550px) {
  .auditConvo { height: max(355px, calc(100dvh - 235px)); }
  .turnHeading time { font-size: 11px; }
  .runHead { flex-wrap: wrap; gap: 0; }
  .runToggle { flex-wrap: wrap; }
}
</style>
