<template>
  <div ref="paneRef" class="pane" :class="{ feed: feed }" v-loading="threadDataLoading" :aria-label="feed ? '渠道会话正文与轨迹' : '原记录正文与轨迹'">
    <el-alert v-if="threadDataError" :title="threadDataError" type="error" :closable="false" show-icon />
    <template v-if="threadData">
      <div class="paneHead" data-reading-header>
        <div v-if="feed" class="detailTitle"><ConversationSourceTag :source="threadSource" /><h2>{{ heading || threadData.messages.find(m => m.direction === 'in')?.content?.slice(0, 96) || partyLabel(threadData.thread) }}</h2></div>
        <div class="ph1">
          <el-tag v-if="partyVisible(threadData.thread)" size="small" effect="plain" :type="partyType(threadData.thread)">{{ partyLabel(threadData.thread) }}</el-tag>
          <b class="mono" :title="identityTitle(threadData.thread)">{{ whoLabel(threadData.thread) }}</b>
          <el-tag v-if="threadData.thread.route_name || threadData.thread.route_key" size="small" effect="plain" type="info" class="mono">{{ threadData.thread.route_name || threadData.thread.route_key }}</el-tag>
          <span class="muted">{{ threadData.thread.message_count }} 条消息 · 最近 {{ fmtTime(threadData.thread.last_active_at, true) }}</span>
        </div>
        <div v-if="!feed" class="ph2 muted mono" :title="threadData.thread.scope_key">scope: {{ threadData.thread.scope_key }}</div>
        <details v-else class="ph2 muted"><summary>会话标识</summary><div class="mono">Thread：{{ threadData.thread.thread_id }}</div><div class="mono">Scope：{{ threadData.thread.scope_key }}</div></details>
      </div>
      <el-collapse v-if="threadData.thread.summary" class="coll summcoll">
        <el-collapse-item title="历史对话摘要">
          <pre class="block">{{ cap(threadData.thread.summary) }}</pre>
        </el-collapse-item>
      </el-collapse>

      <p v-if="!threadData.messages.length" class="muted">此会话暂无已记录的消息。</p>
      <div v-if="earlierMessageId != null" class="messagePager historyControl">
        <span v-if="pageError" role="alert">{{ pageError }}</span>
        <el-button link :loading="moreLoading" :disabled="threadDataLoading" @click="loadEarlierMessages">加载更早消息</el-button>
      </div>
      <div class="chat">
        <div v-for="m in threadData.messages" :key="m.id" class="turn" :data-reading-id="m.id"
          :class="{ fromUser: m.direction === 'in', fromHub: m.direction === 'out', deliveryMessage: isDelivery(m) }">
          <div class="bubbleWrap">
            <div class="bMeta muted"><strong class="actorName"><el-icon aria-hidden="true"><Promotion v-if="isDelivery(m)" /><User v-else-if="m.direction === 'in'" /><ChatLineSquare v-else /></el-icon>{{ messageActorLabel(m) }}</strong>
              <span v-if="m.direction === 'in'" class="actorIdentity" :title="identityTitle(threadData.thread)">{{ whoLabel(threadData.thread) }}</span>
              <time :datetime="m.created_at">{{ fmtTime(m.created_at, true) }}</time></div>
            <div class="bubble"><RichText :text="m.content" /></div>
            <div v-if="traceOwners.has(m.id)" class="traceLine">
              <span v-if="m.direction === 'in'" class="pendingReply muted">已显示的记录中暂无对应回复</span>
              <button type="button" class="tracetoggle" :aria-expanded="Boolean(traces[traceKey(m)]?.open)" @click="toggleTrace(m)">
                <svg class="traceCaret" :class="{ open: traces[traceKey(m)]?.open }" viewBox="0 0 1024 1024" aria-hidden="true">
                  <path d="M0.085333 239.36L512 784.64l511.914667-545.28z" fill="currentColor"></path>
                </svg>
                执行轨迹
                <span v-if="traceBadge(traceKey(m))" class="muted">{{ traceBadge(traceKey(m)) }}</span>
              </button>
              <div v-if="traces[traceKey(m)]?.open" class="tracebox" v-loading="traces[traceKey(m)]?.loading">
                <template v-if="traces[traceKey(m)]?.detail">
                  <div class="tmeta2">
                    <template v-if="isAgentTrace(traceKey(m))">
                      <el-tag size="small" type="primary" effect="plain">本地智能体编排</el-tag>
                      <HelpTip title="本地智能体执行轨迹">客户端负责规划和工具选择，隐藏推理不会上传。中枢记录可核验的工具调用、审批与执行结果。</HelpTip>
                    </template>
                    <el-tag size="small" :title="traces[traceKey(m)].detail.status" :type="statusType(traces[traceKey(m)].detail.status)" effect="plain">{{ traceStatusLabel(traces[traceKey(m)].detail.status) }}</el-tag>
                    <span v-if="traceModel(traceKey(m))" class="mono muted">{{ traceModel(traceKey(m)) }}</span>
                    <span v-if="traceDuration(traceKey(m))" class="muted">{{ (traceDuration(traceKey(m)) / 1000).toFixed(1) }}s</span>
                    <span v-if="traceTokenCount(traceKey(m))" class="muted">{{ traceTokenCount(traceKey(m)) }} tok</span>
                  </div>
                  <el-button v-if="traces[traceKey(m)].detail.conversation_audit_id" size="small" plain type="primary" class="traceDetailBtn" @click="emit('open-audit', traces[traceKey(m)].detail.conversation_audit_id, traces[traceKey(m)].detail.client_turn_id)">查看客户端完整对话</el-button>
                  <div v-if="isAgentTrace(traceKey(m)) && traces[traceKey(m)].summary?.partial" class="agentTracePartial">
                    本轮工具记录超过单次展示上限，以下是已通过归属校验的部分轨迹，不代表全量。
                  </div>
                  <div v-if="!isAgentTrace(traceKey(m))" class="muted toolsum">{{ fmtTools(traces[traceKey(m)].detail?.dispatch?.tools) }}</div>
                  <div v-if="isAgentTrace(traceKey(m)) && traces[traceKey(m)].invocations.length" class="agentInvocations">
                    <div v-for="inv in traces[traceKey(m)].invocations" :key="inv.job_id" class="agentInvocation">
                      <el-tag size="small" effect="plain" type="primary" class="mono">{{ inv.tool }}</el-tag>
                      <span class="muted">{{ invocationStateLabel(inv) }}</span>
                      <span v-if="inv.duration_ms" class="muted">{{ (inv.duration_ms / 1000).toFixed(1) }}s</span>
                      <el-button link type="primary" size="small" @click.stop="emit('open-job', inv.job_id)">工具详情</el-button>
                    </div>
                  </div>
                  <el-timeline v-if="traces[traceKey(m)].events?.length" class="tline">
                    <el-timeline-item v-for="(a, i) in traces[traceKey(m)].events" :key="i" :timestamp="fmtTime(a.ts)" placement="top">
                      <b>{{ traceTitle(a) }}</b>
                      <el-tag v-if="a.source" size="small" effect="plain" :type="a.source === 'local_agent' ? 'primary' : 'info'" class="traceSource">{{ traceSourceLabel(a.source) }}</el-tag>
                      <el-tag size="small" effect="plain" :type="traceStageType(a.stage)" class="traceStage">{{ traceStageLabel(a.stage) }}</el-tag>
                      <el-tag v-if="a.severity && a.severity !== 'info'" size="small" effect="plain" :type="traceSeverityType(a.severity)" class="traceSeverity">{{ a.severity }}</el-tag>
                      <span v-if="traceSummaryText(a)" class="muted auditTag">{{ traceSummaryText(a) }}</span>
                      <template v-if="detailLen(a.detail)">
                        <el-collapse v-if="detailLen(a.detail) > 160" class="auditcoll">
                          <el-collapse-item :title="shortDetail(a.detail)"><pre class="block">{{ fullDetail(a.detail) }}</pre></el-collapse-item>
                        </el-collapse>
                        <div v-else class="muted detail-json">{{ shortDetail(a.detail) }}</div>
                      </template>
                    </el-timeline-item>
                  </el-timeline>
                  <div v-else class="muted notrace">这一轮没有可展示的执行事件</div>
                  <div v-if="isAgentTrace(traceKey(m)) && traces[traceKey(m)].summary?.tool_invocations === 0 && !traces[traceKey(m)].invocations.length" class="muted notrace">本轮未调用中枢治理工具。</div>
                  <el-button v-if="m.job_id" plain type="primary" size="small" class="traceDetailBtn" @click="emit('open-job', m.job_id)">查看完整详情</el-button>
                </template>
                <div v-else-if="!traces[traceKey(m)]?.loading" class="muted">未能取得本轮执行轨迹。<el-button link type="primary" @click="retryTrace(m)">重试读取</el-button></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <footer v-if="nextMessageId || pageError || threadData.messages.length < threadData.thread.message_count" class="messagePager">
        <span class="muted">已显示 {{ threadData.messages.length }} 条消息，共记录 {{ threadData.thread.message_count }} 条。</span>
        <span v-if="pageError && !earlierMessageId" role="alert">{{ pageError }}</span>
        <el-button v-if="nextMessageId" :loading="moreLoading" :disabled="threadDataLoading" @click="loadMoreMessages">加载后续消息</el-button>
      </footer>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { User, ChatLineSquare, Promotion } from '@element-plus/icons-vue';
import { api } from '../request';
import ConversationSourceTag from './ConversationSourceTag.vue';
import type { ConversationFeedItem } from './conversation-audit';
import { readingPosition, restoreReadingPosition } from './conversation-reading-position';
import { fmtTime } from '../util';
import RichText from './RichText.vue';
import HelpTip from './HelpTip.vue';
import { traceKey, threadTraceOwners } from './conversation-audit';
import { cap, detailLen, shortDetail, fullDetail, fmtTools, statusType, traceStatusLabel, traceTitle, traceSummaryText, traceStageLabel, traceStageType, traceSeverityType,
  partyLabel, partyVisible, partyType, whoLabel, identityTitle, type TraceEvent, type TracePayload } from '../task-trace-presentation';

const props = defineProps<{ threadId: number; feed?: boolean; heading?: string; source?: ConversationFeedItem['source'] }>();
const emit = defineEmits<{ 'open-audit': [id: string, turn?: string]; 'open-job': [id: string] }>();
interface AgentRunInvocation {
  job_id: string;
  invocation_id: string;
  tool: string;
  status: string;
  state: string | null;
  ok: boolean | null;
  business_status: string | number | null;
  approval_status: string | null;
  approval_id: number | null;
  event_count: number;
  duration_ms?: number;
  created_at: string;
  updated_at: string;
}
interface AgentRunTracePayload {
  kind: 'agent_client_run';
  run: any;
  trace: { summary?: any; events: TraceEvent[] };
  invocations: AgentRunInvocation[];
}
interface ThreadMessage {
  id: number;
  direction: 'in' | 'out';
  content: string;
  channel?: string;
  is_channel_delivery?: boolean;
  created_at: string;
  job_id?: string | null;
  agent_run_id?: string | null;
}
interface ConversationTraceState {
  kind: 'job' | 'agent-run';
  open: boolean;
  loading: boolean;
  detail: any;
  events: TraceEvent[];
  summary: any | null;
  invocations: AgentRunInvocation[];
}
interface ThreadPage {
  thread: any;
  messages: ThreadMessage[];
  has_more?: boolean;
  next_after_id?: number | null;
  has_earlier?: boolean;
  next_before_id?: number | null;
}
const threadData = ref<ThreadPage | null>(null);
const earlierMessageId = computed(() => threadData.value?.has_earlier ? threadData.value.next_before_id : null);
const nextMessageId = computed(() => messageCursor(threadData.value));
const moreLoading = ref(false), pageError = ref('');
let loadedPages = 0;
const threadDataLoading = ref(false);
const threadDataError = ref('');
let threadLoadGeneration = 0;
const paneRef = ref<HTMLElement | null>(null);
// 逐轮执行轨迹缓存：job:<id> / agent-run:<id> 分开命名，避免两类 UUID 语义混淆。
const traces = reactive<Record<string, ConversationTraceState>>({});
function channelSource(channel?: string): ConversationFeedItem['source'] {
  if (channel?.startsWith('chat:')) return 'web';
  if (channel?.startsWith('agent:')) return 'client';
  if (channel?.startsWith('wecom:')) return 'wecom';
  return 'other';
}
const threadSource = computed(() => props.source ?? (threadData.value?.thread.delivery_only ? 'delivery' : channelSource(threadData.value?.thread.channel)));
function isDelivery(message: ThreadMessage): boolean {
  return message.direction === 'out' && (message.is_channel_delivery ?? ['delivery', 'brain-send'].includes(message.channel || ''));
}
function messageActorLabel(message: ThreadMessage): string {
  if (isDelivery(message)) return '渠道送达';
  if (message.direction === 'in') {
    const source = channelSource(message.channel || threadData.value?.thread.channel);
    if (source === 'client' && !message.agent_run_id) return '客户端发起';
    return source === 'other' ? '接入方发起' : '用户';
  }
  if (message.agent_run_id) return '本地智能体';
  return message.channel === 'hub' ? '中枢回复' : '出站消息';
}

const traceOwners = computed(() => threadTraceOwners(threadData.value?.messages || []));
function isAgentTrace(key: string): boolean {
  return traces[key]?.kind === 'agent-run';
}
function traceSourceLabel(source: TraceEvent['source']): string {
  return source === 'local_agent' ? '本地编排' : '中枢治理';
}
function invocationStateLabel(invocation: AgentRunInvocation): string {
  if (invocation.approval_status === 'denied') return '审批拒绝';
  if (invocation.approval_status === 'pending') return '等待审批';
  if (invocation.approval_status === 'approved' && invocation.state === 'awaiting_approval') return '已批准，等待本地智能体续执行';
  const labels: Record<string, string> = {
    executed: '执行成功', business_rejected: '业务拒绝', awaiting_approval: '等待审批', denied: '审批拒绝',
    rejected_before_dispatch: '派发前拦截', reconciliation_required: '需要人工对账', in_progress: '执行中',
  };
  return labels[invocation.state || ''] || invocation.state || traceStatusLabel(invocation.status);
}
// 轨迹徽标（懒拉后才有）：工具次数 / 识图次数 / 耗时
function traceBadge(key: string): string {
  const tr = traces[key];
  if (!tr || !tr.detail) return '';
  const parts: string[] = [];
  const tools = tr.summary?.tool_invocations ?? tr.summary?.tool_results ?? (tr.events || []).filter((a) => a.event === 'tool_result').length;
  if (tools) parts.push(tools + ' 次工具');
  const vc = tr.summary?.perceptions ?? (tr.events || []).filter((a) => a.event === 'perception').length;
  if (vc) parts.push(vc + ' 次识图');
  const warn = tr.summary?.warning_count ?? 0;
  if (warn) parts.push(warn + ' 警告');
  const err = tr.summary?.error_count ?? 0;
  if (err) parts.push(err + ' 错误');
  const dur = traceDuration(key);
  if (dur) parts.push((dur / 1000).toFixed(1) + 's');
  return parts.length ? '· ' + parts.join(' · ') : '';
}
function traceModel(key: string): string {
  const d = traces[key]?.detail;
  return String(d?.model || d?.runtime || d?.dispatch?.target_config?.model || d?.target || '');
}
function traceDuration(key: string): number {
  const trace = traces[key];
  return Number(trace?.summary?.duration_ms ?? trace?.detail?.usage?.duration_ms ?? 0) || 0;
}
function traceTokenCount(key: string): number {
  const usage = traces[key]?.detail?.usage ?? {};
  return Number(usage.total_tokens ?? usage.tokens ?? 0) || 0;
}

function messageCursor(page: ThreadPage | null): number | null {
  const id = page?.next_after_id;
  return page?.has_more === true && typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}
function appendPage(current: ThreadPage, next: ThreadPage, after: number): ThreadPage {
  const cursor = messageCursor(next);
  if (next.thread.thread_id !== current.thread.thread_id || (next.has_more && (cursor === null || cursor <= after))) {
    throw new Error('消息分页位置未能核对');
  }
  return { ...next, messages: [...current.messages, ...next.messages.filter(message => message.id > after)] };
}
function readPage(id: number, query = ''): Promise<ThreadPage> {
  return api<ThreadPage>(`/admin/api/threads/${id}${query ? '?' + query : ''}`);
}
function prependPage(current: ThreadPage, older: ThreadPage, before: number): ThreadPage {
  if (older.thread.thread_id !== current.thread.thread_id ||
      (older.has_earlier && (older.next_before_id == null || older.next_before_id >= before))) {
    throw new Error('消息分页位置未能核对');
  }
  return { ...current, messages: [...older.messages.filter(m => m.id < before), ...current.messages],
    has_earlier: older.has_earlier, next_before_id: older.next_before_id };
}
async function loadEarlierMessages(): Promise<void> {
  const before = earlierMessageId.value;
  if (!before || !threadData.value || threadDataLoading.value || moreLoading.value) return;
  const generation = threadLoadGeneration;
  moreLoading.value = true; pageError.value = '';
  try {
    const older = await readPage(props.threadId, 'before_id=' + before);
    if (generation !== threadLoadGeneration || !threadData.value) return;
    const position = readingPosition(paneRef.value);
    threadData.value = prependPage(threadData.value, older, before);
    await nextTick();
    if (generation === threadLoadGeneration) restoreReadingPosition(paneRef.value, position, false);
  } catch { if (generation === threadLoadGeneration) pageError.value = '更早消息读取失败，请重试。'; }
  finally { if (generation === threadLoadGeneration) moreLoading.value = false; }
}
async function loadMoreMessages(): Promise<void> {
  const after = nextMessageId.value;
  if (!after || !threadData.value || threadDataLoading.value || moreLoading.value) return;
  const generation = threadLoadGeneration;
  moreLoading.value = true; pageError.value = '';
  try {
    const next = await readPage(props.threadId, 'after_id=' + after);
    if (generation !== threadLoadGeneration || !threadData.value) return;
    threadData.value = appendPage(threadData.value, next, after);
    loadedPages++;
  } catch {
    if (generation === threadLoadGeneration) pageError.value = '后续消息读取失败，请重试。';
  } finally {
    if (generation === threadLoadGeneration) moreLoading.value = false;
  }
}
async function loadThread(id: number): Promise<void> {
  const generation = ++threadLoadGeneration;
  const isNew = threadData.value?.thread.thread_id !== id;
  const pagesToRefresh = isNew ? 1 : Math.max(loadedPages, 1);
  if (isNew) { threadData.value = null; loadedPages = 0; }
  threadDataLoading.value = true; threadDataError.value = ''; moreLoading.value = false; pageError.value = '';
  const openKeys = new Set(Object.keys(traces).filter(key => !isNew && traces[key].open));
  for (const key of Object.keys(traces)) if (isNew || traces[key].loading) delete traces[key];
  try {
    const firstLoaded = !isNew ? threadData.value?.messages[0]?.id : undefined;
    let data = await readPage(id, props.feed ? 'tail=1' : '');
    while (generation === threadLoadGeneration && data.has_earlier && firstLoaded != null &&
        data.next_before_id != null && data.next_before_id > firstLoaded) {
      const before = data.next_before_id;
      data = prependPage(data, await readPage(id, 'before_id=' + before), before);
    }
    let pages = 1;
    while (generation === threadLoadGeneration && pages < pagesToRefresh) {
      const after = messageCursor(data);
      if (!after) break;
      data = appendPage(data, await readPage(id, 'after_id=' + after), after);
      pages++;
    }
    if (generation !== threadLoadGeneration) return;
    const position = isNew ? null : readingPosition(paneRef.value);
    threadData.value = data; loadedPages = pages;
    for (const key of Object.keys(traces)) delete traces[key];
    for (const message of data.messages) {
      if (traceOwners.value.has(message.id) && openKeys.has(traceKey(message))) void toggleTrace(message);
    }
    await nextTick();
    if (generation === threadLoadGeneration && (isNew || props.feed)) restoreReadingPosition(paneRef.value, position, true);
  } catch {
    if (generation === threadLoadGeneration) threadDataError.value = threadData.value ? '会话读取失败，当前展示旧快照，请刷新重试。' : '未能读取此会话，请刷新重试。';
  } finally {
    if (generation === threadLoadGeneration) threadDataLoading.value = false;
  }
}
async function toggleTrace(message: ThreadMessage): Promise<void> {
  const generation = threadLoadGeneration;
  const key = traceKey(message);
  const cur = traces[key];
  if (cur?.open || cur?.loading) { cur.open = !cur.open; return; }
  if (cur?.detail) { cur.open = true; return; }
  const kind: ConversationTraceState['kind'] = message.job_id ? 'job' : 'agent-run';
  traces[key] = { kind, open: true, loading: true, detail: null, events: [], summary: null, invocations: [] };
  try {
    if (message.job_id) {
      const t = await api<TracePayload>('/admin/api/runs/' + message.job_id + '/trace');
      if (generation !== threadLoadGeneration) return;
      traces[key] = { kind, open: Boolean(traces[key]?.open), loading: false, detail: t.job, events: t.trace.events, summary: t.trace.summary ?? null, invocations: [] };
    } else if (message.agent_run_id) {
      const t = await api<AgentRunTracePayload>(`/admin/api/threads/${props.threadId}/agent-runs/${message.agent_run_id}/trace`);
      if (generation !== threadLoadGeneration) return;
      traces[key] = { kind, open: Boolean(traces[key]?.open), loading: false, detail: t.run, events: t.trace.events, summary: t.trace.summary ?? null, invocations: t.invocations ?? [] };
    } else {
      throw new Error('该轮缺少可追溯标识');
    }
  } catch {
    if (generation !== threadLoadGeneration) return;
    traces[key] = { kind, open: Boolean(traces[key]?.open), loading: false, detail: null, events: [], summary: null, invocations: [] };
  }
}

function retryTrace(message: ThreadMessage): void {
  delete traces[traceKey(message)];
  void toggleTrace(message);
}
function refresh(): Promise<void> { return loadThread(props.threadId); }
watch(() => props.threadId, id => void loadThread(id), { immediate: true });
onBeforeUnmount(() => { threadLoadGeneration++; });
function scrollToLatest(): void { restoreReadingPosition(paneRef.value, null, true); }
defineExpose({ refresh, scrollToLatest, loading: threadDataLoading });
</script>

<style scoped>
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.block { background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 10px 12px; margin: 0; font: 12px/1.55 var(--bz-mono); white-space: pre-wrap; word-break: break-all; max-height: 320px; overflow: auto; }
.toolsum { margin-bottom: 8px; }
.detail-json { font-family: var(--bz-mono); font-size: 11px; word-break: break-all; }
	.auditTag { margin-left: 8px; font-family: var(--bz-mono); font-size: 11px; }
	.traceStage { margin-left: 8px; vertical-align: 1px; }
	.traceSeverity { margin-left: 4px; vertical-align: 1px; }
	.auditcoll { margin-top: 2px; border-top: none; }
	.auditcoll :deep(.el-collapse-item__header) { font-family: var(--bz-mono); font-size: 11px; height: auto; line-height: 1.6; padding: 2px 0; border-bottom: none; color: var(--el-text-color-secondary); white-space: nowrap; overflow: hidden; }
	.auditcoll :deep(.el-collapse-item__content) { padding-bottom: 6px; }
	.auditcoll :deep(.el-collapse-item__wrap) { border-bottom: none; }
.pane { --pane-inset: 18px; flex: 1; overflow-y: auto; padding: 0 var(--pane-inset) 14px; min-width: 0; }
.paneHead { position: sticky; top: 0; background: var(--el-bg-color); padding: 14px var(--pane-inset) 10px; margin: 0 calc(-1 * var(--pane-inset)) 6px; border-bottom: 1px solid var(--el-border-color-lighter); z-index: 1; }
.ph1 { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ph2 { margin-top: 4px; word-break: break-all; }
.ph1 { overflow-wrap: anywhere; }
.agentInvocation, .tmeta { overflow-wrap: anywhere; }
.summcoll { margin-bottom: 8px; }
.chat { display: flex; flex-direction: column; gap: 14px; padding-top: 6px; }
.turn { display: flex; }
.turn.fromUser { justify-content: flex-end; }
.turn.fromHub { justify-content: flex-start; }
.bubbleWrap { max-width: 80%; min-width: 0; }
.bMeta { font-size: 11px; margin-bottom: 3px; }
.turn.fromUser .bMeta { text-align: right; }
.bubble { border-radius: 0; padding: 8px 12px; word-break: break-word; }
.turn.fromUser .bubble { background: var(--el-color-primary-light-9); border: 1px solid var(--el-color-primary-light-7); }
.turn.fromHub .bubble { background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); }
.traceLine { margin-top: 4px; }
.tracetoggle { border: 0; padding: 2px 0; background: none; font-family: inherit; display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--el-text-color-secondary); cursor: pointer; user-select: none; }
.tracetoggle:hover { color: var(--el-color-primary); }
.traceCaret { width: 10px; height: 10px; color: currentColor; transform: rotate(-90deg); transition: transform .14s ease; flex: none; }
.traceCaret.open { transform: rotate(0deg); }
.tracebox { margin-top: 6px; padding: 10px 12px; border: 1px dashed var(--el-border-color); border-radius: 0; background: var(--el-fill-color-blank); }
.traceDetailBtn { margin-top: 4px; height: 26px; padding: 0 10px; }
.tmeta2 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.agentTracePartial { margin: 6px 0 9px; padding: 7px 9px; background: var(--el-color-warning-light-9); color: var(--el-text-color-regular); font-size: 12px; line-height: 1.55; }
.agentInvocations { display: flex; flex-direction: column; gap: 5px; margin: 7px 0 10px; }
.agentInvocation { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-height: 28px; padding: 4px 7px; border: 1px solid var(--el-border-color-lighter); background: var(--el-fill-color-light); }
.agentInvocation :deep(.el-button) { margin-left: auto; }
.traceSource { margin-left: 8px; vertical-align: 1px; }
.tline { padding-left: 4px; margin-top: 4px; }
.notrace { font-size: 12px; margin: 4px 0; }
.tracetoggle:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.messagePager { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; margin: 16px 0 4px; }
.messagePager [role=alert] { color: var(--el-color-danger); }
.pendingReply { display: block; margin: 5px 0; }
.pane.feed { --pane-inset: clamp(16px, 2vw, 32px); padding-bottom: 18px; }
.feed .paneHead { padding-block: 12px 9px; margin-bottom: 4px; }
.detailTitle { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.feed h2 { font-size: 19px; line-height: 1.5; margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.feed summary { cursor: pointer; }
.feed .chat { gap: 16px; padding-top: 12px; }
.feed .bubbleWrap { max-width: 88%; }
.actorName, .bMeta { display: flex; align-items: center; gap: 5px; }
.actorName { font-size: 12px; color: var(--el-text-color-primary); }
.bMeta { gap: 9px; flex-wrap: wrap; margin-bottom: 4px; }
.bMeta time { font-variant-numeric: tabular-nums; }
.actorIdentity { overflow-wrap: anywhere; }
.fromUser .bMeta { justify-content: flex-end; }
.feed .bubble :deep(.rich) { font-size: 14px; }
.deliveryMessage .actorName { color: var(--el-color-warning); }
.feed .traceLine { margin-top: 6px; }
.feed .tracetoggle { color: var(--el-color-primary); }
.historyControl { margin-block: 6px; }
</style>
