<template>
  <div ref="paneRef" class="pane" :class="{ feed: feed }" v-loading="threadDataLoading" :aria-label="feed ? '渠道会话正文与轨迹' : '原记录正文与轨迹'">
    <el-alert v-if="threadDataError" :title="threadDataError" type="error" :closable="false" show-icon />
    <template v-if="threadData">
      <div class="paneHead">
        <h2 v-if="feed">{{ heading || threadData.messages.find(m => m.direction === 'in')?.content?.slice(0, 96) || partyLabel(threadData.thread) }}</h2>
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
        <el-collapse-item title="记忆层滚动摘要（更早的对话已折叠进这里，装配上下文时注入）">
          <pre class="block">{{ cap(threadData.thread.summary) }}</pre>
        </el-collapse-item>
      </el-collapse>

      <p v-if="!threadData.messages.length" class="muted">此会话暂无已记录的消息。</p>
      <div class="chat">
        <div v-for="m in threadData.messages" :key="m.id" class="turn" :class="m.direction === 'in' ? 'fromUser' : 'fromHub'">
          <div class="bubbleWrap">
            <div class="bMeta muted">{{ messageActorLabel(m, threadData.thread) }} · {{ fmtTime(m.created_at, true) }}</div>
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
                    <el-tag v-if="isAgentTrace(traceKey(m))" size="small" type="primary" effect="plain">本地智能体编排</el-tag>
                    <el-tag size="small" :title="traces[traceKey(m)].detail.status" :type="statusType(traces[traceKey(m)].detail.status)" effect="plain">{{ traceStatusLabel(traces[traceKey(m)].detail.status) }}</el-tag>
                    <span v-if="traceModel(traceKey(m))" class="mono muted">{{ traceModel(traceKey(m)) }}</span>
                    <span v-if="traceDuration(traceKey(m))" class="muted">{{ (traceDuration(traceKey(m)) / 1000).toFixed(1) }}s</span>
                    <span v-if="traceTokenCount(traceKey(m))" class="muted">{{ traceTokenCount(traceKey(m)) }} tok</span>
                  </div>
                  <div v-if="isAgentTrace(traceKey(m))" class="agentTraceHint">
                    本地智能体负责理解、规划和工具选择；隐藏推理不会上传。以下只展示中枢可验证的运行边界、ACC 工具治理、审批与结果。
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
        <span v-if="pageError" role="alert">{{ pageError }}</span>
        <el-button v-if="nextMessageId" :loading="moreLoading" :disabled="threadDataLoading" @click="loadMoreMessages">加载后续消息</el-button>
      </footer>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { api } from '../request';
import { fmtTime } from '../util';
import RichText from './RichText.vue';
import { traceKey, threadTraceOwners } from './conversation-audit';
import { cap, detailLen, shortDetail, fullDetail, fmtTools, statusType, traceStatusLabel, traceTitle, traceSummaryText, traceStageLabel, traceStageType, traceSeverityType,
  partyLabel, partyVisible, partyType, whoLabel, identityTitle, type TraceEvent, type TracePayload } from '../task-trace-presentation';

const props = defineProps<{ threadId: number; feed?: boolean; heading?: string }>();
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
}
const threadData = ref<ThreadPage | null>(null);
const nextMessageId = computed(() => messageCursor(threadData.value));
const moreLoading = ref(false), pageError = ref('');
let loadedPages = 0;
const threadDataLoading = ref(false);
const threadDataError = ref('');
let threadLoadGeneration = 0;
const paneRef = ref<HTMLElement | null>(null);
// 逐轮执行轨迹缓存：job:<id> / agent-run:<id> 分开命名，避免两类 UUID 语义混淆。
const traces = reactive<Record<string, ConversationTraceState>>({});
function messageActorLabel(message: ThreadMessage, thread: any): string {
  if (message.direction === 'in') return whoLabel(thread);
  return message.agent_run_id ? '本地智能体' : '中枢';
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
function readPage(id: number, after?: number): Promise<ThreadPage> {
  return api<ThreadPage>(`/admin/api/threads/${id}${after == null ? '' : '?after_id=' + after}`);
}
async function loadMoreMessages(): Promise<void> {
  const after = nextMessageId.value;
  if (!after || !threadData.value || threadDataLoading.value || moreLoading.value) return;
  const generation = threadLoadGeneration;
  moreLoading.value = true; pageError.value = '';
  try {
    const next = await readPage(props.threadId, after);
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
    let data = await readPage(id);
    let pages = 1;
    while (generation === threadLoadGeneration && pages < pagesToRefresh) {
      const after = messageCursor(data);
      if (!after) break;
      data = appendPage(data, await readPage(id, after), after);
      pages++;
    }
    if (generation !== threadLoadGeneration) return;
    threadData.value = data; loadedPages = pages;
    for (const key of Object.keys(traces)) delete traces[key];
    for (const message of data.messages) {
      if (traceOwners.value.has(message.id) && openKeys.has(traceKey(message))) void toggleTrace(message);
    }
    if (isNew) {
      await nextTick();
      if (generation === threadLoadGeneration && paneRef.value) paneRef.value.scrollTop = props.feed ? 0 : paneRef.value.scrollHeight;
    }
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
defineExpose({ refresh, loading: threadDataLoading });
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
.pane { flex: 1; overflow-y: auto; padding: 14px 18px; min-width: 0; }
.paneHead { position: sticky; top: -14px; background: var(--el-bg-color); padding: 4px 0 10px; margin: -4px 0 6px; border-bottom: 1px solid var(--el-border-color-lighter); z-index: 1; }
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
.agentTraceHint { margin: 6px 0 9px; padding: 7px 9px; background: var(--el-color-primary-light-9); color: var(--el-text-color-regular); font-size: 12px; line-height: 1.55; }
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
.pane.feed { padding: 0 clamp(16px, 2vw, 32px) 18px; }
.feed .paneHead { position: static; background: transparent; padding: 17px 0 12px; margin: 0 0 4px; }
.feed h2 { font-size: 19px; line-height: 1.5; margin: 0 0 6px; overflow-wrap: anywhere; }
.feed summary { cursor: pointer; }
.feed .turn { display: block; }
.feed .bubbleWrap { max-width: 100%; }
.feed .chat { gap: 0; }
.feed .turn { padding: 12px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.pane.feed .turn .bMeta { margin-bottom: 5px; text-align: left; }
.pane.feed .turn .bubble { background: transparent; border: 0; padding: 0; }
.feed .turn.fromUser .bubble { font-weight: 600; }
.feed .traceLine { margin-top: 8px; }
.feed .tracetoggle { color: var(--el-color-primary); }
</style>
