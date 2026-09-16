<template>
  <div class="task-control-page">
    <header class="task-heading">
      <div><div class="eyebrow">本地智能体 / 运行边界</div><h1>任务控制</h1><p>为一项连续业务任务固定授权范围、累计写预算和同时执行数量。</p></div>
      <div class="actions"><el-button @click="router.push('/agent-clients')">智能体客户端</el-button><el-button :loading="listLoading" @click="loadTasks()">刷新</el-button><el-button v-if="canWrite" type="primary" @click="openCreate">{{ createAttempt ? '继续原创建' : '创建受控任务' }}</el-button></div>
    </header>
    <el-card shadow="never" class="explanation">
      <div class="explanation-grid"><div><b>例如：商城上架商品，再核对库存</b><p>明确选定商城和库存系统的原授权、工作空间、本地会话及工具。保留各系统原有权限与审批。</p></div><div><b>累计写预算 ≠ 每分钟限流</b><p>按业务写调用计数，包含待确认的预留；不是商品数量，也不是成功次数。读取不扣写预算，仍受并发限制。</p></div><div><b>暂停只阻止新的派发</b><p>已获许可的调用仍可能完成。继续不补充预算、不执行或重放业务；取消不会撤回已产生的变化。</p></div></div>
    </el-card>
    <el-alert v-if="listError" type="error" :closable="false" :title="listError" show-icon />
    <el-card shadow="never">
      <template #header><div class="section-heading"><b>已创建的任务</b><span class="muted">范围与预算创建后固定 · 点击任务查看原调用</span></div></template>
      <el-table v-loading="listLoading" :data="tasks" row-key="task_id" @row-click="row => openDetail(row.task_id)">
        <el-table-column label="任务" min-width="160"><template #default="{ row }"><el-button link type="primary" @click.stop="openDetail(row.task_id)">{{ shortId(row.task_id) }}</el-button><div class="muted">{{ time(row.created_at) }}</div></template></el-table-column>
        <el-table-column label="固定范围" min-width="190"><template #default="{ row }"><b>{{ row.members.length }} 个成员</b><div class="muted">{{ [...new Set(row.members.map((m: Member) => m.workspace))].join(' · ') }}</div></template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="stateType(row)" effect="plain">{{ stateText(row) }}</el-tag></template></el-table-column>
        <el-table-column label="累计写调用" min-width="160"><template #default="{ row }"><b>{{ row.counters.write_reserved + row.counters.write_consumed }} / {{ limitText(row.policy.max_write_calls) }}</b><div class="muted">预留 {{ row.counters.write_reserved }} · 已派发 {{ row.counters.write_consumed }}</div></template></el-table-column>
        <el-table-column label="执行中 / 并发上限" width="150"><template #default="{ row }">{{ row.counters.active_permits }} / {{ row.policy.max_concurrent }}</template></el-table-column>
        <el-table-column label="截止时间" min-width="165"><template #default="{ row }">{{ time(row.policy.expires_at, '不设截止') }}</template></el-table-column>
        <template #empty><span>{{ listError ? '未能取得任务列表，请重试。' : '还没有受控任务。创建前请先确认客户端支持任务绑定。' }}</span></template>
      </el-table>
      <div v-if="nextTaskCursor" class="load-more"><el-button :loading="listLoading" @click="loadTasks(true)">加载更多</el-button></div>
    </el-card>

    <el-dialog v-model="createOpen" title="创建受控任务" width="min(920px, 96vw)" top="5vh" body-class="bailing-task-create-body" :close-on-click-modal="false">
      <el-alert v-if="createAttempt" type="warning" :closable="false" show-icon title="已保留原创建请求。重试会核对同一请求，不会换一个请求重复创建。" />
      <el-alert v-if="catalogError" type="info" :closable="false" :title="catalogError" />
      <el-form label-position="top" class="creation-form" :disabled="creating || Boolean(createAttempt)" @submit.prevent="saveCreate">
        <div class="section-heading"><h2>1. 固定业务范围</h2><el-button :disabled="members.length >= 64" @click="addMember">添加授权成员</el-button></div>
        <p class="muted">仅同一中枢。每个成员需对应客户端选中的原授权和真实本地会话 ID；不能填写显示名称代替标识。</p>
        <article v-for="(member, index) in members" :key="member.key" class="member-editor">
          <div class="section-heading"><b>成员 {{ index + 1 }}</b><div class="actions"><el-switch v-model="member.manual" active-text="手工填写标识" /><el-button v-if="members.length > 1" link type="danger" @click="members.splice(index, 1)">移除</el-button></div></div>
          <el-form-item v-if="!member.manual" label="原业务授权">
            <el-select v-model="member.session_id" filterable placeholder="按业务授权名称、设备或 Session 选择" @change="id => selectSession(member, id)">
              <el-option v-for="session in sessions" :key="session.session_id" :value="session.session_id" :label="sessionLabel(session)" />
            </el-select>
            <div class="field-note">名称仅帮助识别；保存的是原 Session。{{ sessions.length }} / {{ sessionTotal }} 个有效授权已加载。<el-button v-if="sessions.length < sessionTotal" link :loading="catalogLoading" @click="loadSessions(true)">加载更多</el-button></div>
          </el-form-item>
          <div class="form-grid">
            <el-form-item label="Agent Session ID"><el-input v-model="member.session_id" :readonly="!member.manual" placeholder="原授权的 UUID" /></el-form-item>
            <el-form-item label="接入方 Client App ID"><el-input v-model="member.client_app_id" :readonly="!member.manual" maxlength="64" placeholder="例如 shop-app" /></el-form-item>
            <el-form-item label="工作空间 Workspace"><el-input v-if="member.manual" v-model="member.workspace" maxlength="64" placeholder="原授权允许的工作空间" /><el-select v-else v-model="member.workspace" placeholder="明确选择工作空间"><el-option v-for="workspace in workspaceChoices(member)" :key="workspace.route" :label="`${workspace.name || workspace.route}（${workspace.route}）`" :value="workspace.route" /></el-select></el-form-item>
            <el-form-item label="本地会话 ID"><el-input v-model="member.client_conversation_id" maxlength="128" placeholder="从客户端宿主取得，区分于 Session ID" /></el-form-item>
          </div>
          <el-form-item label="允许的精确工具名称"><el-input v-model="member.tools" type="textarea" :rows="2" placeholder="每行一个或用逗号分隔，例如 product_update、inventory_read；不接受 *" /><div class="field-note">填写此目标真实存在的工具名。任务范围只收窄权限，不会开通工具或绕过审批。</div></el-form-item>
        </article>
        <h2>2. 设置累计预算与并发</h2>
        <div class="form-grid policy-grid">
          <el-form-item label="累计写调用预算"><el-select v-model="writeMode"><el-option value="bounded" label="限制累计写调用次数" /><el-option value="readonly" label="0 次：仅允许读取" /><el-option value="unlimited" label="不限累计写调用次数" /></el-select><el-input-number v-if="writeMode === 'bounded'" v-model="writeLimit" :min="1" :max="1000000000" :precision="0" placeholder="填写次数" /></el-form-item>
          <el-form-item label="同时执行上限"><el-input-number v-model="concurrent" :min="1" :max="10000" :precision="0" /><div class="field-note">读取和写入共同占用。结果未知时继续占用，不自动再执行。</div></el-form-item>
          <el-form-item label="截止时间（可空）"><el-input v-model="expires" type="datetime-local" clearable /><div class="field-note">留空即不设截止。按浏览器本地时区填写，保存为 UTC。</div></el-form-item>
        </div>
        <div class="enrollment-notice"><b>此设置会持续约束所选原授权</b><p>创建成功后，这些 Agent Session 在所有本地会话中都必须绑定明确的受控任务；省略任务将不能访问业务。取消当前任务也不会恢复不受任务约束的访问。客户端需先具备任务绑定能力，已有其他会话也需安排对应任务。</p><el-checkbox v-model="stickyAck">我已确认客户端支持任务绑定，并理解原授权在其他会话中的持续约束。</el-checkbox></div>
      </el-form>
      <el-alert v-if="formError" type="error" :closable="false" show-icon :title="formError" />
      <template #footer><el-button :disabled="creating" @click="createOpen = false">{{ createAttempt ? '稍后继续' : '取消' }}</el-button><el-button type="primary" :loading="creating" :disabled="!createAttempt && !stickyAck" @click="saveCreate">{{ createAttempt ? '重试原创建请求' : '确认范围并创建' }}</el-button></template>
    </el-dialog>

    <el-drawer v-model="detailOpen" title="受控任务详情" size="min(1040px, 96vw)" @closed="closeDetail">
      <el-alert v-if="detailError" type="error" :closable="false" :title="detailError" show-icon />
      <div v-loading="detailLoading" class="detail-body">
        <template v-if="detail">
          <div class="section-heading"><div><el-tag :type="stateType(detail)" effect="plain">{{ stateText(detail) }}</el-tag><code class="task-id">{{ detail.task_id }}</code></div><el-button :loading="detailLoading" @click="loadDetail(detail.task_id)">刷新快照</el-button></div>
          <p class="muted">更新于 {{ time(detail.updated_at) }} · 控制修订 {{ detail.revision }} · 记录序号 {{ detail.ledger_sequence }}。此快照不是派发许可。</p>
          <div class="detail-metrics"><div><span>累计写调用 / 预算</span><b>{{ detail.counters.write_reserved + detail.counters.write_consumed }} / {{ limitText(detail.policy.max_write_calls) }}</b><small>预留 {{ detail.counters.write_reserved }} · 已确认派发 {{ detail.counters.write_consumed }}</small></div><div><span>执行中 / 并发上限</span><b>{{ detail.counters.active_permits }} / {{ detail.policy.max_concurrent }}</b><small>包含结果未知、尚未结算的许可</small></div><div><span>截止时间</span><b class="date-value">{{ time(detail.policy.expires_at, '不设截止') }}</b><small>{{ detail.members.length }} 个固定成员</small></div></div>
          <el-alert v-if="detail.state === 'blocked'" type="warning" :closable="false" title="原成员身份或授权核验未通过。请先处理原因，再暂停并重新核验；不能移除成员后继续。" />
          <el-alert v-if="detail.state === 'cancelled'" type="info" :closable="false" title="任务已取消，不能继续。原调用回执仍可核对，已发生的业务变化不会撤回。" />
          <div v-if="canWrite" class="control-panel"><div><b>控制后续派发</b><p>暂停保留在途调用；继续不补预算、不执行待办；取消不可恢复，也不回滚业务。</p></div><div class="actions"><el-button :disabled="controlBusy || !detailVerified || !['active', 'blocked'].includes(detail.state)" @click="control('pause')">暂停</el-button><el-button type="primary" plain :disabled="controlBusy || !detailVerified || detail.state !== 'paused' || expired(detail)" @click="control('resume')">继续</el-button><el-button type="danger" plain :disabled="controlBusy || !detailVerified || detail.state === 'cancelled'" @click="control('cancel')">取消任务</el-button></div></div>
          <h2>固定的业务范围</h2>
          <article v-for="(member, index) in detail.members" :key="`${member.session_id}:${member.workspace}:${member.client_conversation_id}`" class="member-snapshot"><div class="section-heading"><b>成员 {{ index + 1 }} · {{ member.client_app_id }} / {{ member.workspace }}</b></div><dl><dt>原授权 Session</dt><dd><code>{{ member.session_id }}</code></dd><dt>本地会话</dt><dd><code>{{ member.client_conversation_id }}</code></dd><dt>精确工具</dt><dd><el-tag v-for="tool in member.allowed_tools" :key="tool" type="info" effect="plain">{{ tool }}</el-tag></dd></dl></article>
          <div class="binding-note"><b>交给客户端宿主的任务标识</b><p>宿主读取任务并核对全部已选原授权后绑定。任务 ID 不替代业务授权，也不交给模型自行选择。</p><el-button size="small" @click="copyTaskId">复制任务 ID</el-button></div>
          <h2>原调用记录</h2><p class="muted">这里只读取关联和执行状态，不查询业务正文，也不会继续或重新派发调用。已派发不代表业务成功。</p>
          <el-table :data="invocations" size="small" row-key="invocation_id">
            <el-table-column type="expand"><template #default="{ row }"><dl class="invocation-ids"><dt>原调用</dt><dd><code>{{ row.invocation_id }}</code></dd><dt>原授权</dt><dd><code>{{ row.session_id }}</code></dd><dt>原运行</dt><dd><code>{{ row.run_id }}</code></dd><dt>原 Job</dt><dd><code>{{ row.job_id }}</code></dd></dl></template></el-table-column>
            <el-table-column label="工具" min-width="170"><template #default="{ row }"><code>{{ row.tool }}</code><div class="muted">{{ row.readonly ? '读取' : '写入' }} · 第 {{ row.attempt }} 次许可</div></template></el-table-column>
            <el-table-column label="写预算" width="100"><template #default="{ row }">{{ budgetText(row.budget_state) }}</template></el-table-column>
            <el-table-column label="执行许可" width="100"><template #default="{ row }">{{ permitText(row.permit_state) }}</template></el-table-column>
            <el-table-column label="派发结果" min-width="150"><template #default="{ row }">{{ outcomeText(row.outcome) }}<div class="muted">{{ row.terminal ? '原操作已结束' : '原操作未结束' }}</div></template></el-table-column>
            <template #empty>尚无关联调用。创建任务本身不会执行业务。</template>
          </el-table>
          <div v-if="nextInvocationCursor" class="load-more"><el-button :loading="detailLoading" @click="loadDetail(detail.task_id, true)">加载更多原调用</el-button></div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../request';
import { kernelMountPath } from '../runtime-path';
import { useMe } from '../store';

interface Member { session_id: string; client_app_id: string; workspace: string; client_conversation_id: string; allowed_tools: string[] }
interface Task { task_id: string; state: 'active' | 'paused' | 'blocked' | 'cancelled'; revision: number; ledger_sequence: number; scope_hash: string; members: Member[]; policy: { max_write_calls: number | null; max_concurrent: number; expires_at: string | null }; counters: { write_reserved: number; write_consumed: number; active_permits: number }; created_at: string; updated_at: string }
interface Invocation { session_id: string; invocation_id: string; run_id: string; job_id: string; tool: string; readonly: boolean; budget_state: string | null; permit_state: string; outcome: string | null; terminal: boolean; attempt: number }
interface Session { session_id: string; client_app_id: string; device_label: string; allowed_routes: string[]; subject_display?: { name?: string }; subject_display_status?: string }
interface Workspace { route: string; name: string }
interface DraftMember { key: string; manual: boolean; session_id: string; client_app_id: string; workspace: string; client_conversation_id: string; tools: string }
interface CreateBody { request_id: string; members: Member[]; policy: Task['policy'] }

const router = useRouter(), route = useRoute(), me = useMe();
const canWrite = computed(() => me.can('clients:write'));
const tasks = ref<Task[]>([]), listLoading = ref(false), listError = ref(''), nextTaskCursor = ref<string | null>(null);
const detail = ref<Task | null>(null), detailOpen = ref(false), detailLoading = ref(false), detailError = ref('');
const detailVerified = ref(false);
const invocations = ref<Invocation[]>([]), nextInvocationCursor = ref<string | null>(null);
let detailEpoch = 0;
const createOpen = ref(false), creating = ref(false), formError = ref(''), createAttempt = ref<CreateBody | null>(null);
const sessions = ref<Session[]>([]), sessionTotal = ref(0), workspaces = ref<Workspace[]>([]), catalogLoading = ref(false), catalogError = ref('');
const members = ref<DraftMember[]>([]), writeMode = ref<'bounded' | 'readonly' | 'unlimited'>('bounded'), writeLimit = ref<number>();
const concurrent = ref(1), expires = ref(''), stickyAck = ref(false), controlBusy = ref(false);
const controlAttempt = ref<{ taskId: string; request_id: string; expected_revision: number; action: 'pause' | 'resume' | 'cancel' } | null>(null);
const storageKey = () => `bailing:task-create:v1:${kernelMountPath()}:${me.me?.username ?? ''}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const shortId = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;
const time = (value?: string | null, empty = '—') => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : empty;
const expired = (task: Task) => Boolean(task.policy.expires_at && Date.parse(task.policy.expires_at) <= Date.now());
const limitText = (limit: number | null) => limit === null ? '不限' : limit === 0 ? '0（只读）' : String(limit);
function stateText(task: Task) { return task.state === 'cancelled' ? '已取消' : expired(task) ? '已过期' : ({ active: '运行可用', paused: '已暂停', blocked: '整组阻断' })[task.state]; }
function stateType(task: Task): 'info' | 'warning' | 'danger' | 'success' { return task.state === 'cancelled' ? 'info' : expired(task) || task.state === 'paused' ? 'warning' : task.state === 'blocked' ? 'danger' : 'success'; }
const budgetText = (state: string | null) => state === null ? '不扣写预算' : ({ reserved: '已预留', consumed: '已计入', released: '已释放' }[state] ?? '未知');
const permitText = (state: string) => ({ none: '未获许可', held: '执行中', unknown: '结果未知', settled: '已结算' }[state] ?? '未知');
const outcomeText = (state: string | null) => state === null ? '待确认' : ({ confirmed_dispatched: '已确认派发', confirmed_not_dispatched: '已确认未派发', unknown: '结果未知，保留占用' }[state] ?? '未知');
function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : '未知错误';
  const messages: Record<string, string> = { TASK_UNSUPPORTED: '当前实例尚未启用任务控制，请确认版本与迁移状态。', TASK_UNAVAILABLE: '任务服务暂时不可用，请保留原请求重试。', TASK_MEMBER_MISMATCH: '原授权、工作空间或本地会话不匹配，请核对精确标识。', TASK_SCOPE_BLOCKED: '至少一个原成员的授权或身份核验未通过，整组范围已阻断。', TASK_REVISION_CONFLICT: '任务已被其他操作更新，已重新读取快照；请根据新状态决定是否操作。', TASK_CONFLICT: '此请求已关联不同内容，请先核对原创建结果。', TASK_INVALID_INPUT: '字段格式不正确，请核对原标识、精确工具名及预算。', TASK_EXPIRED: '任务已过期，不能继续派发。', TASK_CANCELLED: '任务已取消，不能继续。', TASK_CONTROL_CONFLICT: '当前状态不允许该操作，请刷新快照。', TASK_RECORD_INVALID: '任务记录校验未通过，请由管理员检查。' };
  return messages[code] ? `${messages[code]}（${code}）` : `请求未完成，请重试。${code}`;
}
async function loadTasks(more = false) {
  if (listLoading.value) return;
  listLoading.value = true; listError.value = '';
  try {
    const query = new URLSearchParams({ limit: '30' });
    if (more && nextTaskCursor.value) query.set('before', nextTaskCursor.value);
    const result = await api<{ items: Task[]; next_cursor: string | null }>(`/admin/api/agent-tasks?${query}`);
    tasks.value = more ? [...tasks.value, ...result.items] : result.items; nextTaskCursor.value = result.next_cursor;
  } catch (error) { listError.value = errorText(error); }
  finally { listLoading.value = false; }
}
async function openDetail(taskId: string) {
  if (detail.value?.task_id !== taskId) { detail.value = null; detailVerified.value = false; invocations.value = []; nextInvocationCursor.value = null; }
  detailOpen.value = true; void router.replace({ query: { task: taskId } }); await loadDetail(taskId);
}
function closeDetail() { detailEpoch++; void router.replace({ query: {} }); }
async function loadDetail(taskId: string, more = false) {
  const epoch = ++detailEpoch; detailLoading.value = true; detailVerified.value = false; detailError.value = '';
  try {
    const query = new URLSearchParams({ limit: '30' });
    if (more && nextInvocationCursor.value) query.set('before', nextInvocationCursor.value);
    const result = await api<{ task: Task; invocations: Invocation[]; next_cursor: string | null }>(`/admin/api/agent-tasks/${encodeURIComponent(taskId)}?${query}`);
    if (epoch !== detailEpoch) return;
    detail.value = result.task; detailVerified.value = true; invocations.value = more ? [...invocations.value, ...result.invocations] : result.invocations; nextInvocationCursor.value = result.next_cursor;
  } catch (error) { if (epoch === detailEpoch) detailError.value = errorText(error); }
  finally { if (epoch === detailEpoch) detailLoading.value = false; }
}
async function loadSessions(more = false) {
  catalogLoading.value = true;
  try {
    const result = await api<{ list: Session[]; total: number }>(`/admin/api/agent-clients/sessions?state=active&limit=50&offset=${more ? sessions.value.length : 0}`);
    sessions.value = more ? [...sessions.value, ...result.list] : result.list; sessionTotal.value = result.total;
  } catch { catalogError.value = '暂时无法读取授权目录。可稍后重试，或手工填写经过核对的原授权标识；不会自动选择其他授权。'; }
  finally { catalogLoading.value = false; }
}
function sessionLabel(session: Session) { return `${session.subject_display_status === 'provided' ? session.subject_display?.name || '授权名称待同步' : '授权名称待同步'} · ${session.client_app_id} · ${session.device_label || '未命名设备'} · ${shortId(session.session_id)}`; }
function workspaceChoices(member: DraftMember): Workspace[] {
  const session = sessions.value.find((item) => item.session_id === member.session_id);
  if (!session) return [];
  return session.allowed_routes.includes('*') ? workspaces.value : session.allowed_routes.map((route) => workspaces.value.find((w) => w.route === route) ?? { route, name: route });
}
function selectSession(member: DraftMember, id: string) { const session = sessions.value.find((item) => item.session_id === id); member.client_app_id = session?.client_app_id ?? ''; member.workspace = ''; member.tools = ''; }
function addMember() { members.value.push({ key: crypto.randomUUID(), manual: false, session_id: '', client_app_id: '', workspace: '', client_conversation_id: '', tools: '' }); }
function fillAttempt(body: CreateBody) {
  members.value = body.members.map((m) => ({ key: crypto.randomUUID(), manual: true, session_id: m.session_id, client_app_id: m.client_app_id, workspace: m.workspace, client_conversation_id: m.client_conversation_id, tools: m.allowed_tools.join('\n') }));
  writeMode.value = body.policy.max_write_calls === null ? 'unlimited' : body.policy.max_write_calls === 0 ? 'readonly' : 'bounded';
  writeLimit.value = body.policy.max_write_calls ?? undefined; concurrent.value = body.policy.max_concurrent;
  const deadline = body.policy.expires_at ? new Date(body.policy.expires_at) : null;
  expires.value = deadline ? new Date(deadline.getTime() - deadline.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''; stickyAck.value = true;
}
async function openCreate() {
  if (!canWrite.value) return;
  formError.value = ''; catalogError.value = '';
  if (createAttempt.value) fillAttempt(createAttempt.value);
  else { members.value = []; addMember(); writeMode.value = 'bounded'; writeLimit.value = undefined; concurrent.value = 1; expires.value = ''; stickyAck.value = false; }
  createOpen.value = true;
  await Promise.allSettled([loadSessions(), api<{ workspaces: Workspace[] }>('/admin/api/agent-clients/overview?days=30').then((result) => { workspaces.value = result.workspaces; })]);
}
function createBody(): CreateBody {
  if (!stickyAck.value) throw new Error('请先确认原授权在所有会话中的持续约束。');
  const normalized = members.value.map((m, i) => {
    const tools = m.tools.split(/[\s,，、]+/).filter(Boolean);
    if (!uuid.test(m.session_id) || !m.client_app_id.trim() || m.client_app_id !== m.client_app_id.trim()
      || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(m.workspace) || m.workspace === 'auto'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(m.client_conversation_id)) throw new Error(`成员 ${i + 1}：请填写有效的原 Session、Client、工作空间和本地会话标识。`);
    if (!tools.length || tools.length > 256 || !tools.every((tool) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(tool))) throw new Error(`成员 ${i + 1}：请填写 1–256 个精确工具名，不接受通配符。`);
    return { session_id: m.session_id.toLowerCase(), client_app_id: m.client_app_id, workspace: m.workspace, client_conversation_id: m.client_conversation_id, allowed_tools: [...new Set(tools)].sort() };
  });
  if (new Set(normalized.map((m) => JSON.stringify([m.session_id, m.workspace, m.client_conversation_id]))).size !== normalized.length) throw new Error('存在重复的原授权、工作空间与本地会话组合。');
  if (writeMode.value === 'bounded' && (!Number.isSafeInteger(writeLimit.value) || writeLimit.value! < 1)) throw new Error('请填写累计写调用次数，或明确选择只读 / 不限。');
  if (!Number.isSafeInteger(concurrent.value) || concurrent.value < 1) throw new Error('并发上限至少为 1。');
  const deadline = expires.value ? new Date(expires.value) : null;
  if (deadline && (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now())) throw new Error('截止时间必须晚于当前时间。');
  return { request_id: crypto.randomUUID(), members: normalized, policy: { max_write_calls: writeMode.value === 'unlimited' ? null : writeMode.value === 'readonly' ? 0 : writeLimit.value!, max_concurrent: concurrent.value, expires_at: deadline?.toISOString() ?? null } };
}
async function saveCreate() {
  if (!canWrite.value || creating.value) return;
  formError.value = '';
  try {
    if (!createAttempt.value) { const body = createBody(); sessionStorage.setItem(storageKey(), JSON.stringify(body)); createAttempt.value = body; }
  } catch (error) { formError.value = error instanceof Error ? error.message : '无法保留原创建请求，请检查浏览器存储。'; return; }
  creating.value = true;
  try {
    const task = await api<Task>('/admin/api/agent-tasks', { method: 'POST', body: JSON.stringify(createAttempt.value) });
    sessionStorage.removeItem(storageKey()); createAttempt.value = null; createOpen.value = false; ElMessage.success('任务已创建，原授权已纳入持续任务约束。');
    await loadTasks(); await openDetail(task.task_id);
  } catch (error) {
    const definitelyRejected = error instanceof Error && ['TASK_INVALID_INPUT', 'TASK_MEMBER_MISMATCH', 'TASK_SCOPE_BLOCKED', 'TASK_EXPIRED'].includes(error.message);
    if (definitelyRejected) { sessionStorage.removeItem(storageKey()); createAttempt.value = null; }
    formError.value = `${errorText(error)} ${definitelyRejected ? '尚未创建，可修正后重新提交。' : '原请求已保留，可重试核对结果。'}`;
  }
  finally { creating.value = false; }
}
async function control(action: 'pause' | 'resume' | 'cancel') {
  if (!detail.value || !detailVerified.value || !canWrite.value || controlBusy.value) return;
  const task = detail.value;
  const messages = { pause: '停止新的派发许可。已获得许可的在途调用仍可能完成，现有预算和原调用保留。', resume: '重新核验整组授权并允许后续派发。不会增加预算，也不会执行或重放待处理业务。', cancel: '取消后此任务不能继续，也不会回滚业务。原授权在所有会话中仍须绑定任务。' };
  try { await ElMessageBox.confirm(messages[action], { pause: '暂停任务', resume: '继续任务', cancel: '取消任务' }[action], { type: action === 'cancel' ? 'warning' : 'info', confirmButtonText: '确认', cancelButtonText: '返回' }); } catch { return; }
  controlBusy.value = true;
  if (!controlAttempt.value || controlAttempt.value.taskId !== task.task_id || controlAttempt.value.action !== action) controlAttempt.value = { taskId: task.task_id, request_id: crypto.randomUUID(), expected_revision: task.revision, action };
  const { taskId, ...body } = controlAttempt.value;
  try {
    await api<Task>(`/admin/api/agent-tasks/${encodeURIComponent(taskId)}/control`, { method: 'POST', body: JSON.stringify(body) });
    controlAttempt.value = null; ElMessage.success('任务控制状态已更新；没有派发业务操作。'); await loadDetail(taskId); await loadTasks();
  } catch (error) {
    const message = errorText(error);
    if (error instanceof Error && error.message === 'TASK_REVISION_CONFLICT') { controlAttempt.value = null; await loadDetail(taskId); }
    detailError.value = detailVerified.value ? message : `${message} 请成功刷新快照后再操作。`;
  } finally { controlBusy.value = false; }
}
async function copyTaskId() { try { await navigator.clipboard.writeText(detail.value!.task_id); ElMessage.success('已复制任务 ID'); } catch { ElMessage.warning('复制失败，可选中上方任务 ID 手工复制。'); } }
onMounted(() => {
  try { const saved = JSON.parse(sessionStorage.getItem(storageKey()) || 'null'); if (saved && uuid.test(saved.request_id) && Array.isArray(saved.members) && saved.members.length && saved.policy) createAttempt.value = saved; } catch { /* Failed local drafts never trigger remote writes. */ }
  void loadTasks(); if (typeof route.query.task === 'string' && uuid.test(route.query.task)) void openDetail(route.query.task);
});
</script>

<style scoped>
.task-control-page { display: grid; gap: 18px; }
:global(.bailing-task-create-body) { max-height: 74vh; overflow-y: auto; padding-right: 8px; }
.task-heading, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.task-heading h1 { margin: 5px 0; font-size: 25px; letter-spacing: -.4px; }
.task-heading p, .explanation p, .control-panel p, .binding-note p { color: var(--el-text-color-secondary); margin: 7px 0 0; line-height: 1.7; }
.eyebrow { color: var(--el-color-primary); font-size: 12px; }
.actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.actions :deep(.el-button + .el-button) { margin-left: 0; }
.explanation-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 26px; }
.explanation-grid b { font-size: 14px; }.explanation-grid p { font-size: 13px; }
.muted, .field-note { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; }
.field-note { margin-top: 5px; width: 100%; }
.creation-form h2, .detail-body h2 { font-size: 16px; margin: 22px 0 12px; }
.member-editor, .member-snapshot { border: 1px solid var(--el-border-color-light); padding: 18px; margin-top: 12px; }
.member-editor > .section-heading { margin-bottom: 15px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.creation-form :deep(.el-select), .creation-form :deep(.el-date-editor) { width: 100%; }
.creation-form :deep(.el-input-number) { margin-top: 8px; }
.policy-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.enrollment-notice { background: var(--el-color-warning-light-9); border-left: 3px solid var(--el-color-warning); padding: 16px 18px; margin: 12px 0 18px; }
.enrollment-notice p { line-height: 1.7; font-size: 13px; margin: 8px 0; }
.enrollment-notice :deep(.el-checkbox) { white-space: normal; height: auto; align-items: start; }.enrollment-notice :deep(.el-checkbox__label) { white-space: normal; }
.detail-body { display: grid; gap: 14px; }.detail-body h2 { margin-bottom: 0; }.detail-body > .muted { margin: 0; }
.task-id { margin-left: 12px; overflow-wrap: anywhere; }
.detail-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--el-border-color-light); }
.detail-metrics > div { display: grid; gap: 7px; padding: 18px; }.detail-metrics b { font-size: 24px; }.detail-metrics span,.detail-metrics small { color: var(--el-text-color-secondary); }.detail-metrics b.date-value { font-size: 16px; }
.control-panel, .binding-note { padding: 16px; background: var(--el-fill-color-light); }.control-panel { display: flex; justify-content: space-between; align-items: center; gap: 20px; }.control-panel p,.binding-note p { font-size: 12px; }.binding-note .el-button { margin-top: 10px; }
.member-snapshot { margin: 0; }.member-snapshot dl,.invocation-ids { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 9px; margin: 14px 0 0; font-size: 13px; }.invocation-ids { padding: 0 18px 16px; }.member-snapshot dt,.invocation-ids dt { color: var(--el-text-color-secondary); }.member-snapshot dd,.invocation-ids dd { margin: 0; overflow-wrap: anywhere; }.member-snapshot dd .el-tag { margin: 0 7px 5px 0; }
.load-more { padding-top: 16px; text-align: center; }
@media (max-width: 1050px) { .task-heading { align-items: start; flex-direction: column; }.explanation-grid { grid-template-columns: 1fr; gap: 16px; } }
@media (max-width: 680px) { .form-grid,.policy-grid,.detail-metrics { grid-template-columns: 1fr; }.control-panel,.section-heading { flex-wrap: wrap; }.task-id { display: block; margin: 8px 0; } }
</style>
