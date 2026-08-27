<template>
  <div class="agent-clients-page">
    <el-card shadow="never">
      <template #header>
        <div class="head">
          <div>
            <b>智能体客户端</b>
            <HelpTip title="和执行器有什么区别">
              <p><b>智能体客户端</b>在本地理解用户意图、选择能力并完成多步编排；中枢继续负责业务身份、授权、审批、执行与审计。</p>
              <p><b>执行器</b>是中枢下发 Job、由本地运行时执行本地任务后回报结果。两者是独立概念。</p>
              <p>本页聚合现有接入方、Agent Session 和 Agent Run，不创建第二套接入方配置。</p>
            </HelpTip>
          </div>
          <div class="actions">
            <el-select v-model="days" size="small" style="width: 108px" @change="loadOverview">
              <el-option :value="7" label="近 7 天" />
              <el-option :value="30" label="近 30 天" />
              <el-option :value="90" label="近 90 天" />
            </el-select>
            <el-button size="small" :loading="loading" @click="refreshAll">刷新</el-button>
          </div>
        </div>
      </template>

      <div v-loading="loading" class="overview">
        <div class="metric primary"><span>客户端应用</span><b>{{ int(summary.agent_auth_enabled) }}</b><em>共 {{ int(summary.applications) }} 个接入方</em></div>
        <div class="metric"><span>有效授权设备</span><b>{{ int(summary.sessions?.active) }}</b><em>总会话 {{ int(summary.sessions?.total) }}</em></div>
        <div class="metric"><span>Agent Run</span><b>{{ int(summary.runs) }}</b><em>{{ int(summary.conversations) }} 个本地会话</em></div>
        <div class="metric"><span>工具调用</span><b>{{ int(summary.tool_calls) }}</b><em>审批 {{ int(approvalTotal) }} 次</em></div>
        <div class="metric"><span>累计 Token</span><b>{{ int(summary.total_tokens) }}</b><em>由客户端公开 usage 汇总</em></div>
        <div class="metric" :class="{ danger: Number(summary.failure_rate || 0) > 0.1 }"><span>失败率</span><b>{{ percent(summary.failure_rate) }}</b><em>{{ int(summary.failed) }} 个失败或取消</em></div>
      </div>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="section-head">
          <div><b>客户端应用</b><span>复用“接入方”配置；只有设置 Agent 授权页后才能发起浏览器登录。</span></div>
          <el-button size="small" @click="router.push('/clients')">管理接入方</el-button>
        </div>
      </template>
      <el-empty v-if="!applications.length" description="还没有接入方" />
      <el-table v-else :data="applications" size="small">
        <el-table-column label="应用" :width="180">
          <template #default="{ row }"><div class="stack"><b>{{ row.name || row.app_id }}</b><code>{{ row.app_id }}</code></div></template>
        </el-table-column>
        <el-table-column label="Agent 登录" :min-width="240" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="stack">
              <div><el-tag size="small" effect="plain" :type="row.enabled && row.agent_auth_enabled ? 'success' : 'info'">{{ row.enabled && row.agent_auth_enabled ? '可授权' : '未开放' }}</el-tag></div>
              <span class="muted mono">{{ row.agent_authorize_url || '未配置授权页' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="允许 Workspace" :width="180">
          <template #default="{ row }"><div class="tags"><el-tag v-for="route in previewRoutes(row.allowed_routes)" :key="route" size="small" effect="plain" type="info">{{ route }}</el-tag></div></template>
        </el-table-column>
        <el-table-column label="近期开销" :width="150" align="right">
          <template #default="{ row }"><div class="stack right"><span>{{ int(row.stats.runs) }} Run / {{ int(row.stats.tool_calls) }} 调用</span><span class="muted">{{ int(row.stats.total_tokens) }} Token</span></div></template>
        </el-table-column>
        <el-table-column :width="160" align="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="!row.agent_auth_enabled || !eligibleWorkspaces(row).length" @click="openConnection(row)">生成连接配置</el-button>
            <el-button link @click="router.push('/clients')">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="section-head">
          <div><b>授权设备与 Agent Session</b><span>远程撤销后，后续 access/refresh token 都会失效；本地客户端需要重新登录。</span></div>
          <div class="actions">
            <el-select v-model="sessionFilter.client_app_id" clearable filterable size="small" placeholder="全部应用" style="width: 190px" @change="resetSessions">
              <el-option v-for="app in applications" :key="app.app_id" :label="app.name || app.app_id" :value="app.app_id" />
            </el-select>
            <el-select v-model="sessionFilter.state" size="small" style="width: 112px" @change="resetSessions">
              <el-option value="all" label="全部状态" />
              <el-option value="active" label="有效" />
              <el-option value="expired" label="已过期" />
              <el-option value="revoked" label="已撤销" />
            </el-select>
          </div>
        </div>
      </template>
      <el-empty v-if="!sessions.length" description="当前筛选下没有 Agent Session" />
      <el-table v-else v-loading="sessionsLoading" :data="sessions" size="small">
        <el-table-column label="设备" :width="170">
          <template #default="{ row }"><div class="stack"><b>{{ row.device_label || '未命名设备' }}</b><code>{{ shortId(row.session_id) }}</code></div></template>
        </el-table-column>
        <el-table-column label="业务主体" :width="150">
          <template #default="{ row }"><div class="stack"><span>{{ row.principal?.id || row.on_behalf_of }}</span><span class="muted">{{ row.principal?.tenant || '未声明租户' }}</span></div></template>
        </el-table-column>
        <el-table-column label="应用 / Workspace" :min-width="190">
          <template #default="{ row }"><div class="stack"><code>{{ row.client_app_id }}</code><span class="muted">{{ (row.allowed_routes || []).join('、') || '无可用路由' }}</span></div></template>
        </el-table-column>
        <el-table-column label="活跃与有效期" :width="185">
          <template #default="{ row }"><div class="stack"><span>活跃 {{ fmtTime(row.last_seen_at) }}</span><span class="muted">到期 {{ fmtTime(row.refresh_expires_at) }}</span></div></template>
        </el-table-column>
        <el-table-column label="状态" :width="80"><template #default="{ row }"><el-tag size="small" effect="plain" :type="stateType(row.state)">{{ stateText(row.state) }}</el-tag></template></el-table-column>
        <el-table-column :width="90" align="right">
          <template #default="{ row }"><el-button v-if="row.state !== 'revoked'" link type="danger" :loading="revoking === row.session_id" @click="revoke(row)">远程撤销</el-button><span v-else class="muted">已处理</span></template>
        </el-table-column>
      </el-table>
      <div v-if="sessionTotal > sessionPageSize" class="pagination">
        <el-pagination v-model:current-page="sessionPage" :page-size="sessionPageSize" :total="sessionTotal" layout="prev, pager, next, total" @current-change="loadSessions" />
      </div>
    </el-card>

    <el-dialog v-model="connection.open" title="生成智能体客户端连接配置" width="620px">
      <el-alert type="info" :closable="false" show-icon title="这里只生成公开连接元数据，不包含 Client Token、Agent Token 或模型密钥。" />
      <el-form label-position="top" class="connection-form">
        <el-form-item label="Hub 地址"><el-input :model-value="hubUrl" readonly class="mono" /></el-form-item>
        <div class="form-grid">
          <el-form-item label="Client App ID"><el-input :model-value="connection.app_id" readonly class="mono" /></el-form-item>
          <el-form-item label="Connection Name"><el-input v-model="connection.name" maxlength="128" class="mono" /></el-form-item>
        </div>
        <el-form-item label="Workspace">
          <el-select v-model="connection.workspace" style="width: 100%"><el-option v-for="workspace in connection.workspaces" :key="workspace.route" :label="workspace.name + '（' + workspace.route + '）'" :value="workspace.route" /></el-select>
        </el-form-item>
      </el-form>
      <div class="code-block"><pre>{{ connectionJson }}</pre></div>
      <div class="code-block"><pre>{{ connectionCommand }}</pre></div>
      <template #footer><el-button @click="connection.open = false">关闭</el-button><el-button @click="copy(connectionJson)">复制 JSON</el-button><el-button type="primary" @click="copy(connectionCommand)">复制 DSH 命令</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import HelpTip from '../components/HelpTip.vue';
import { kernelFetch, kernelOrigin } from '../runtime-path';

interface Workspace { route: string; name: string; description?: string }
interface Stats { runs: number; conversations: number; completed: number; failed: number; tool_calls: number; total_tokens: number; approvals: Record<string, number> }
interface Application { app_id: string; name: string; enabled: boolean; agent_auth_enabled: boolean; agent_authorize_url?: string | null; allowed_routes: string[]; last_used_at?: string | null; stats: Stats }
interface SessionRow { session_id: string; client_app_id: string; device_label: string; principal?: { id?: string; tenant?: string; roles?: string[] }; on_behalf_of: string; allowed_routes: string[]; last_seen_at?: string; refresh_expires_at: string; state: 'active' | 'expired' | 'revoked' }

const router = useRouter();
const days = ref(30);
const loading = ref(false);
const sessionsLoading = ref(false);
const revoking = ref('');
const applications = ref<Application[]>([]);
const workspaces = ref<Workspace[]>([]);
const sessions = ref<SessionRow[]>([]);
const sessionTotal = ref(0);
const sessionPage = ref(1);
const sessionPageSize = 50;
const summary = reactive<any>({ applications: 0, agent_auth_enabled: 0, sessions: {}, runs: 0, conversations: 0, failed: 0, tool_calls: 0, total_tokens: 0, failure_rate: 0, approvals: {} });
const sessionFilter = reactive({ client_app_id: '', state: 'all' });
const connection = reactive<{ open: boolean; app_id: string; name: string; workspace: string; workspaces: Workspace[] }>({ open: false, app_id: '', name: '', workspace: '', workspaces: [] });
const hubUrl = computed(() => kernelOrigin());
const approvalTotal = computed(() => Object.values(summary.approvals || {}).reduce((sum: number, value) => sum + Number(value || 0), 0));
const connectionJson = computed(() => JSON.stringify({ hubUrl: hubUrl.value, clientAppId: connection.app_id, workspace: connection.workspace, connectionName: connection.name.trim() || 'default' }, null, 2));
const connectionCommand = computed(() => `/bailinghub connections add ${quote(connection.name.trim() || 'default')} ${quote(hubUrl.value)} ${quote(connection.app_id)} ${quote(connection.workspace)}`);

function quote(value: string): string { return JSON.stringify(value); }
function int(value: unknown): string { return new Intl.NumberFormat('zh-CN').format(Number(value || 0)); }
function percent(value: unknown): string { return `${(Number(value || 0) * 100).toFixed(1)}%`; }
function shortId(value: string): string { return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : '—'; }
function fmtTime(value?: string | null): string { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '从未'; }
function stateText(value: SessionRow['state']): string { return value === 'active' ? '有效' : value === 'expired' ? '已过期' : '已撤销'; }
function stateType(value: SessionRow['state']): 'success' | 'warning' | 'info' { return value === 'active' ? 'success' : value === 'expired' ? 'warning' : 'info'; }
function previewRoutes(routes: string[]): string[] { return routes.includes('*') ? ['全部 Workspace'] : routes.slice(0, 4); }
function eligibleWorkspaces(app: Application): Workspace[] { return workspaces.value.filter((workspace) => app.allowed_routes.includes('*') || app.allowed_routes.includes(workspace.route)); }

async function loadOverview(): Promise<void> {
  loading.value = true;
  try {
    const response = await kernelFetch(`/admin/api/agent-clients/overview?days=${days.value}`);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '加载失败');
    const data = await response.json();
    applications.value = data.applications || [];
    workspaces.value = data.workspaces || [];
    Object.assign(summary, data.summary || {});
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '加载智能体客户端失败'); }
  finally { loading.value = false; }
}

async function loadSessions(): Promise<void> {
  sessionsLoading.value = true;
  try {
    const params = new URLSearchParams({
      state: sessionFilter.state,
      limit: String(sessionPageSize),
      offset: String((sessionPage.value - 1) * sessionPageSize),
    });
    if (sessionFilter.client_app_id) params.set('client_app_id', sessionFilter.client_app_id);
    const response = await kernelFetch(`/admin/api/agent-clients/sessions?${params}`);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '加载失败');
    const data = await response.json();
    sessions.value = data.list || [];
    sessionTotal.value = Number(data.total || 0);
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '加载授权设备失败'); }
  finally { sessionsLoading.value = false; }
}

async function refreshAll(): Promise<void> { await Promise.all([loadOverview(), loadSessions()]); }
async function resetSessions(): Promise<void> { sessionPage.value = 1; await loadSessions(); }
function openConnection(app: Application): void {
  const options = eligibleWorkspaces(app);
  connection.app_id = app.app_id;
  connection.name = app.app_id.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
  connection.workspaces = options;
  connection.workspace = options[0]?.route || '';
  connection.open = true;
}
async function copy(value: string): Promise<void> { await navigator.clipboard.writeText(value); ElMessage.success('已复制'); }
async function revoke(row: SessionRow): Promise<void> {
  await ElMessageBox.confirm(`撤销设备“${row.device_label || shortId(row.session_id)}”的 Agent Session？撤销后需要重新登录授权。`, '远程撤销', { type: 'warning', confirmButtonText: '确认撤销' });
  revoking.value = row.session_id;
  try {
    const response = await kernelFetch(`/admin/api/agent-clients/sessions/${row.session_id}/revoke`, { method: 'POST' });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '撤销失败');
    ElMessage.success('Agent Session 已撤销');
    await refreshAll();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '撤销失败'); }
  finally { revoking.value = ''; }
}

onMounted(refreshAll);
</script>

<style scoped>
.agent-clients-page { display: grid; gap: 16px; }
.head, .section-head, .actions { display: flex; align-items: center; gap: 10px; }
.head, .section-head { justify-content: space-between; }
.section-head > div:first-child { display: flex; align-items: baseline; gap: 10px; }
.section-head span, .muted { color: var(--el-text-color-secondary); font-size: 12px; }
.overview { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
.metric { min-width: 0; padding: 16px; border: 1px solid var(--el-border-color-lighter); border-radius: 10px; background: var(--el-fill-color-blank); }
.metric span, .metric em { display: block; color: var(--el-text-color-secondary); font-style: normal; font-size: 12px; }
.metric b { display: block; margin: 8px 0 5px; font-size: 24px; line-height: 1; }
.metric.primary { border-color: color-mix(in srgb, var(--el-color-primary) 34%, transparent); background: color-mix(in srgb, var(--el-color-primary) 7%, transparent); }
.metric.danger b { color: var(--el-color-danger); }
.stack { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.stack.right { align-items: flex-end; }
.mono, code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.connection-form { margin-top: 18px; }
.pagination { display: flex; justify-content: flex-end; padding-top: 14px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.code-block { margin-top: 10px; padding: 12px; overflow: auto; border-radius: 8px; background: #111827; color: #e5e7eb; }
.code-block pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 12px; }
@media (max-width: 1280px) { .overview { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 760px) { .overview, .form-grid { grid-template-columns: 1fr; } .head, .section-head { align-items: flex-start; flex-direction: column; } }
</style>
