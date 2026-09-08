<template>
  <div class="auditConvo">
    <aside class="auditRail" aria-label="客户端对话列表">
      <div class="railHeading"><b>客户端完整对话</b><span class="muted">按最近更新排序</span></div>
      <div v-loading="listLoading" class="conversationList">
        <el-alert v-if="listError" :title="listError" type="error" :closable="false" />
        <el-empty v-else-if="!listLoading && !conversations.length" :image-size="56" description="尚无客户端正文归档；历史记录可在「原授权记录」查看" />
        <button v-for="item in conversations" :key="item.conversation_id" type="button" class="conversationItem"
          :class="{ selected: currentId === item.conversation_id }" @click="emit('select', item.conversation_id)">
          <div class="itemHeading"><b>{{ item.client_app_id }}</b><el-tag size="small" effect="plain" :type="statusType(item.last_turn_status)">{{ item.last_turn_status ? turnStatusLabel(item.last_turn_status) : auditStatusLabel(item.state) }}</el-tag></div>
          <div class="conversationName mono">{{ item.client_conversation_id }}</div>
          <div class="muted">已接收 {{ item.turn_count }} 轮 / {{ item.message_count }} 条消息 · {{ item.member_count }} 项授权</div>
          <div class="muted itemTime">{{ fmtTime(item.updated_at, true) }}</div>
        </button>
        <div v-if="listMore" class="pager"><el-button link :loading="listMoreLoading" @click="loadMoreConversations">加载更多对话</el-button></div>
      </div>
    </aside>

    <main ref="pane" v-loading="detailLoading" class="auditPane" aria-label="客户端对话正文与授权执行">
      <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" class="notice" />
      <el-empty v-if="!conversation && !detailLoading && !detailError" :image-size="80" description="选择一条对话，查看客户端正文与每轮授权执行" />
      <template v-if="conversation">
        <header class="conversationHeader">
          <div class="headerRow"><b>{{ conversation.client_app_id }}</b><el-tag size="small" effect="plain">{{ conversation.route_key }}</el-tag><el-tag size="small" effect="plain" :type="conversation.state === 'ready' ? 'success' : 'warning'">{{ auditStatusLabel(conversation.state) }}</el-tag></div>
          <div class="mono conversationName">{{ conversation.client_conversation_id }}</div>
          <div class="muted">已接收 {{ conversation.turn_count }} 轮 / {{ conversation.message_count }} 条消息 · {{ conversation.confirmed_count }}/{{ conversation.member_count }} 项授权已确认</div>
          <div class="muted provenance">展示客户端已同步的可见文本，旧历史或未同步内容可能缺失。授权卡片链接中枢验证的执行记录；正文与执行结果分别展示，隐藏推理不在此记录。</div>
          <div class="members"><el-tag v-for="member in members" :key="member.session_id" size="small" effect="plain" :type="member.confirmed ? 'info' : 'warning'">{{ member.display_label || '未命名授权' }}{{ member.confirmed ? '' : ' · 待确认' }}</el-tag></div>
        </header>
        <el-alert v-if="conversation.state !== 'ready'" title="授权成员尚未全部确认，对话归档尚未就绪。" type="warning" :closable="false" class="notice" />
        <div class="loadedCount muted">已加载 {{ turns.length }} 轮、{{ loadedMessageCount }} 条消息（{{ events.length }} 条归档事件）<span v-if="hasMore"> · 下方可继续加载</span></div>
        <el-alert v-if="focusTurn && !turns.some(turn => turn.id === focusTurn)" title="目标轮次尚未加载，请继续加载后续记录。" type="info" :closable="false" class="notice" />
        <el-empty v-if="!turns.length && !detailLoading" :image-size="56" description="尚未收到客户端正文或轮次记录" />

        <section v-for="(turn, index) in turns" :key="turn.id" :data-turn-id="turn.id" class="auditTurn" :class="{ focused: focusTurn === turn.id }">
          <div class="turnHeading"><b>第 {{ index + 1 }} 轮</b><span class="muted mono">{{ turn.id }}</span><el-tag size="small" effect="plain" :type="statusType(turn.end?.status)">{{ turn.end ? turnStatusLabel(turn.end.status) : '尚未收到轮次结束记录' }}</el-tag></div>
          <div v-if="!turn.messages.some(message => message.kind === 'user_message')" class="missingText">本轮尚未收到用户正文。</div>
          <template v-for="event in turn.events" :key="event.event_id">
            <article v-if="event.kind === 'user_message' || event.kind === 'assistant_message'" class="auditMessage" :class="event.kind === 'user_message' ? 'userMessage' : 'assistantMessage'">
              <div class="messageMeta muted">{{ event.kind === 'user_message' ? '用户' : '客户端助手' }} · {{ fmtTime(event.created_at, true) }}</div>
              <div v-if="typeof event.content === 'string'" class="messageText">{{ event.content || '（空消息）' }}</div>
              <div v-else class="messageText missingText">正文未上传或已不可用；不以授权执行摘要替代。</div>
            </article>
          </template>
          <div v-if="turn.end && !turn.messages.some(message => message.kind === 'assistant_message')" class="missingText">本轮已结束，但未收到客户端助手正文。授权执行摘要不能替代完整答复。</div>
          <div v-if="turn.runs.length" class="authorizationRuns">
            <div class="muted runsHeading">本轮各授权执行 · {{ turn.runs.length }} 条关联记录</div>
            <article v-for="run in turn.runs" :key="run.event_id" class="authorizationRun">
              <div class="runHead"><b>{{ memberLabel(run.member_session_id) }}</b><el-tag size="small" effect="plain" :type="statusType(runTraces[run.run_id || '']?.data?.run.status)">{{ runTraces[run.run_id || '']?.data ? auditStatusLabel(runTraces[run.run_id || ''].data?.run.status) : '已关联执行' }}</el-tag></div>
              <div class="muted mono runId">run: {{ run.run_id || '缺少执行标识' }}</div>
              <div class="runActions"><el-button v-if="run.run_id && run.thread_id" size="small" plain :loading="runTraces[run.run_id]?.loading" @click="toggleRunTrace(run)">{{ runTraces[run.run_id]?.open ? '收起授权轨迹' : '查看授权轨迹' }}</el-button><el-button v-if="run.thread_id" size="small" link type="primary" @click="emit('open-thread', run.thread_id)">原授权记录</el-button><span v-if="!run.thread_id" class="missingText">缺少原授权记录关联，无法打开执行轨迹。</span></div>
              <div v-if="run.run_id && runTraces[run.run_id]?.open" class="runTrace">
                <el-alert v-if="runTraces[run.run_id].error" :title="runTraces[run.run_id].error" type="error" :closable="false" />
                <template v-if="runTraces[run.run_id].data">
                  <div class="muted">以下是该授权的中枢执行轨迹，不是完整对话正文。</div>
                  <el-alert v-if="runTraces[run.run_id].data?.trace.summary?.partial" title="原执行接口返回的是部分工具轨迹，不代表全量。可继续从原授权记录排查。" type="warning" :closable="false" class="notice" />
                  <div v-for="invocation in runTraces[run.run_id].data?.invocations" :key="invocation.job_id" class="invocation"><b class="mono">{{ invocation.tool }}</b><span>{{ invocationStatus(invocation) }}</span><el-button link type="primary" size="small" @click="emit('open-job', invocation.job_id)">工具详情</el-button></div>
                  <el-timeline v-if="runTraces[run.run_id].data?.trace.events.length" class="executionTimeline">
                    <el-timeline-item v-for="(event, eventIndex) in runTraces[run.run_id].data?.trace.events" :key="eventIndex" :timestamp="fmtTime(event.ts, true)" placement="top">
                      <b>{{ event.title || event.event }}</b><div v-if="event.summary" class="muted">{{ event.summary }}</div>
                      <el-collapse v-if="event.detail && Object.keys(event.detail).length"><el-collapse-item title="事件详情"><pre class="eventDetail">{{ JSON.stringify(event.detail, null, 2) }}</pre></el-collapse-item></el-collapse>
                    </el-timeline-item>
                  </el-timeline>
                  <div v-else class="muted">该授权尚无可展示的执行事件。</div>
                </template>
              </div>
            </article>
          </div>
          <div v-else class="muted noRuns">本轮尚无已关联的授权执行记录。</div>
        </section>
        <div v-if="hasMore" class="pager"><el-button :loading="moreLoading" @click="loadMoreEvents">加载后续记录</el-button><div class="muted">按原顺序继续加载；同一轮跨页记录会合并展示。</div></div>
        <div v-else-if="events.length" class="pager muted">已加载当前全部已接收事件 · 旧历史或未同步内容可能缺失；刷新可获取后续上传内容</div>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { api } from '../request';
import { fmtTime } from '../util';
import { auditStatusLabel, groupAuditTurns, mergeAuditEvents } from './conversation-audit';
import type { AuditConversation, AuditMember, AuditEvent, AuditListPage, AuditDetailPage } from './conversation-audit';

const props = defineProps<{ selectedId?: string; focusTurn?: string }>();
const emit = defineEmits<{ select: [id: string]; 'open-thread': [id: number]; 'open-job': [id: string] }>();
interface Invocation { job_id: string; tool: string; state?: string | null; status: string; approval_status?: string | null }
interface RunTrace {
  run: { status: string };
  trace: { summary?: { partial?: boolean }; events: Array<{ ts: string; event: string; title?: string; summary?: string; detail?: Record<string, unknown> }> };
  invocations: Invocation[];
}
interface RunTraceState { loading: boolean; open: boolean; data: RunTrace | null; error: string }
const LIST_PAGE = 50, EVENT_PAGE = 100;
const conversations = ref<AuditConversation[]>([]), listLoading = ref(false), listMoreLoading = ref(false), listMore = ref(false), listOffset = ref<number | null>(0), listError = ref('');
const currentId = ref(''), conversation = ref<AuditConversation | null>(null), members = ref<AuditMember[]>([]), events = ref<AuditEvent[]>([]);
const detailLoading = ref(false), moreLoading = ref(false), hasMore = ref(false), afterSequence = ref<number | null>(0), detailError = ref(''), pane = ref<HTMLElement | null>(null);
const runTraces = reactive<Record<string, RunTraceState>>({});
let listGeneration = 0, detailGeneration = 0;
const turns = computed(() => groupAuditTurns(events.value));
const loadedMessageCount = computed(() => events.value.filter(event => event.kind === 'user_message' || event.kind === 'assistant_message').length);
function statusType(status?: string | null): 'info' | 'success' | 'warning' | 'danger' {
  if (status === 'completed' || status === 'executed' || status === 'ready') return 'success';
  if (status === 'failed' || status === 'denied' || status === 'business_rejected') return 'danger';
  if (status === 'running' || status === 'awaiting_approval') return 'warning';
  return 'info';
}
function memberLabel(sessionId?: string): string { return members.value.find(member => member.session_id === sessionId)?.display_label || '未识别授权（保留原执行关联）'; }
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
async function loadConversations(): Promise<void> {
  const generation = ++listGeneration;
  listLoading.value = true; listError.value = ''; listMoreLoading.value = false;
  try {
    const page = await api<AuditListPage>(`/admin/api/conversation-audits?limit=${LIST_PAGE}&offset=0`);
    if (generation !== listGeneration) return;
    conversations.value = page.items; listMore.value = page.has_more; listOffset.value = page.next_offset;
  } catch (error) { if (generation === listGeneration) listError.value = (error as Error).message; }
  finally { if (generation === listGeneration) listLoading.value = false; }
}
async function loadMoreConversations(): Promise<void> {
  if (listLoading.value || listMoreLoading.value || !listMore.value || listOffset.value == null) return;
  const generation = listGeneration;
  listMoreLoading.value = true;
  try {
    const page = await api<AuditListPage>(`/admin/api/conversation-audits?limit=${LIST_PAGE}&offset=${listOffset.value}`);
    if (generation !== listGeneration) return;
    const rows = new Map(conversations.value.map(item => [item.conversation_id, item]));
    for (const item of page.items) rows.set(item.conversation_id, item);
    conversations.value = [...rows.values()]; listMore.value = page.has_more; listOffset.value = page.next_offset;
  } catch (error) { if (generation === listGeneration) listError.value = (error as Error).message; }
  finally { if (generation === listGeneration) listMoreLoading.value = false; }
}
function applyPage(page: AuditDetailPage): void {
  conversation.value = page.conversation; members.value = page.members;
  events.value = mergeAuditEvents(events.value, page.events); hasMore.value = page.has_more; afterSequence.value = page.next_after_sequence;
}
async function focusLoadedTurn(): Promise<void> {
  if (!props.focusTurn) return;
  await nextTick();
  const target = [...(pane.value?.querySelectorAll<HTMLElement>('[data-turn-id]') ?? [])].find(element => element.dataset.turnId === props.focusTurn);
  if (target && pane.value) pane.value.scrollTop += target.getBoundingClientRect().top - pane.value.getBoundingClientRect().top - 12;
}
async function openConversation(id: string): Promise<void> {
  const generation = ++detailGeneration;
  currentId.value = id; conversation.value = null; events.value = []; members.value = []; hasMore.value = false; afterSequence.value = 0;
  detailLoading.value = true; moreLoading.value = false; detailError.value = '';
  for (const key of Object.keys(runTraces)) delete runTraces[key];
  try {
    const page = await api<AuditDetailPage>(`/admin/api/conversation-audits/${encodeURIComponent(id)}?after_sequence=0&limit=${EVENT_PAGE}`);
    if (generation !== detailGeneration) return;
    applyPage(page); await nextTick(); if (pane.value) pane.value.scrollTop = 0; await focusLoadedTurn();
  } catch (error) { if (generation === detailGeneration) detailError.value = (error as Error).message; }
  finally { if (generation === detailGeneration) detailLoading.value = false; }
}
async function loadMoreEvents(): Promise<void> {
  if (!currentId.value || detailLoading.value || moreLoading.value || !hasMore.value || afterSequence.value == null) return;
  const generation = detailGeneration;
  moreLoading.value = true; detailError.value = '';
  try {
    const page = await api<AuditDetailPage>(`/admin/api/conversation-audits/${encodeURIComponent(currentId.value)}?after_sequence=${afterSequence.value}&limit=${EVENT_PAGE}`);
    if (generation !== detailGeneration) return;
    applyPage(page); await focusLoadedTurn();
  } catch (error) { if (generation === detailGeneration) detailError.value = (error as Error).message; }
  finally { if (generation === detailGeneration) moreLoading.value = false; }
}
async function toggleRunTrace(run: AuditEvent): Promise<void> {
  if (!run.run_id || !run.thread_id) return;
  const existing = runTraces[run.run_id];
  if (existing?.open) { existing.open = false; return; }
  if (existing?.data) { existing.open = true; return; }
  const generation = detailGeneration, id = run.run_id;
  runTraces[id] = { loading: true, open: true, data: null, error: '' };
  try {
    const data = await api<RunTrace>(`/admin/api/threads/${run.thread_id}/agent-runs/${encodeURIComponent(id)}/trace`);
    if (generation === detailGeneration) runTraces[id] = { loading: false, open: true, data, error: '' };
  } catch (error) { if (generation === detailGeneration) runTraces[id] = { loading: false, open: true, data: null, error: `授权轨迹未能读取：${(error as Error).message}` }; }
}
async function refresh(): Promise<void> { await Promise.all([loadConversations(), currentId.value ? openConversation(currentId.value) : Promise.resolve()]); }
watch(() => props.selectedId, id => { if (id && id !== currentId.value) void openConversation(id); }, { immediate: true });
watch(() => props.focusTurn, () => { void focusLoadedTurn(); });
onMounted(() => { void loadConversations(); });
defineExpose({ refresh });
</script>

<style scoped>
.auditConvo { display: flex; height: calc(100vh - 270px); min-height: 470px; border: 1px solid var(--el-border-color); overflow: hidden; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono, monospace); }
.auditRail { flex: 0 0 300px; width: 300px; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--el-border-color); }
.railHeading { display: flex; flex-direction: column; gap: 4px; padding: 14px; border-bottom: 1px solid var(--el-border-color-lighter); }
.conversationList { overflow-y: auto; flex: 1; }
.conversationItem { display: block; width: 100%; border: 0; border-bottom: 1px solid var(--el-border-color-lighter); padding: 14px; text-align: left; cursor: pointer; font: inherit; color: inherit; background: transparent; }
.conversationItem:hover { background: var(--el-fill-color-light); }
.conversationItem.selected { background: var(--el-color-primary-light-9); box-shadow: inset 3px 0 var(--el-color-primary); }
.conversationItem:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
.itemHeading, .headerRow, .turnHeading, .runHead, .runActions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.itemHeading { justify-content: space-between; }
.conversationName { overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; margin: 6px 0; }
.itemTime { margin-top: 5px; }
.auditPane { flex: 1; min-width: 0; overflow-y: auto; padding: 16px 20px; }
.conversationHeader { padding-bottom: 16px; border-bottom: 1px solid var(--el-border-color); }
.provenance { margin-top: 10px; line-height: 1.65; }
.members { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.notice { margin: 12px 0; }
.loadedCount { margin: 16px 0; }
.auditTurn { padding: 0 0 24px; margin-bottom: 20px; border-bottom: 1px solid var(--el-border-color-lighter); }
.auditTurn.focused { outline: 1px solid var(--el-color-primary-light-5); outline-offset: 8px; }
.turnHeading { padding-bottom: 14px; }
.turnHeading .mono { overflow-wrap: anywhere; }
.auditMessage { width: fit-content; max-width: 88%; margin: 12px 0; }
.auditMessage.userMessage { margin-left: auto; }
.messageMeta { margin: 0 0 5px; }
.userMessage .messageMeta { text-align: right; }
.messageText { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.75; padding: 11px 14px; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); }
.userMessage .messageText { background: var(--el-color-primary-light-9); border-color: var(--el-color-primary-light-7); }
.missingText { color: var(--el-color-warning-dark-2); font-size: 12px; line-height: 1.65; }
.authorizationRuns { margin: 18px 0 0; border-left: 2px solid var(--el-border-color); padding-left: 12px; }
.runsHeading { margin-bottom: 8px; }
.authorizationRun { border: 1px solid var(--el-border-color-lighter); padding: 12px; margin-top: 8px; }
.runId { margin: 7px 0; overflow-wrap: anywhere; }
.runActions { margin-top: 8px; }
.runActions .el-button + .el-button { margin-left: 0; }
.runTrace { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--el-border-color); }
.invocation { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px 0; font-size: 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
.invocation .el-button { margin-left: auto; }
.executionTimeline { padding: 16px 0 0 4px; }
.eventDetail { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; font-size: 12px; }
.noRuns { margin-top: 14px; }
.pager { padding: 18px 10px; text-align: center; }
.pager .muted { margin-top: 8px; }
@media (max-width: 1000px) { .auditRail { width: 240px; flex-basis: 240px; } .auditPane { padding: 14px; } }
@media (max-width: 1000px) { .auditConvo { flex-direction: column; height: auto; min-height: 0; } .auditRail { width: 100%; flex-basis: auto; border-right: 0; max-height: 240px; border-bottom: 1px solid var(--el-border-color); } .auditPane { max-height: 75vh; min-height: 280px; } .auditMessage { max-width: 100%; } }
</style>
