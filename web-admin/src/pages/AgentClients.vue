<template>
  <div class="agent-clients-page">
    <div class="page-navigation"><div><b>本地智能体</b><span>配置接入与管理授权设备</span></div><el-radio-group v-model="pageTab"><el-radio-button value="setup">接入配置</el-radio-button><el-radio-button value="activity">设备与运行</el-radio-button></el-radio-group></div>
    <el-card v-if="pageTab === 'activity'" shadow="never">
      <template #header>
        <div class="head">
          <div>
            <b>智能体客户端</b>
            <HelpTip title="和执行器有什么区别">
              <p><b>智能体客户端</b>在本地理解用户意图、选择能力并完成多步编排；中枢继续负责业务身份、授权、审批、执行与审计。</p>
              <p><b>执行器</b>是中枢下发 Job、由本地运行时执行本地任务后回报结果。两者是独立概念。</p>
              <p>在“配置接入”中集中设置授权入口、系统说明和工具范围；设置仍保存在原接入方与业务路由中。</p>
              <p>每个接入方只配置一个不绑定账号、租户或门店的业务授权入口；账号切换与租户选择由业务授权页完成。</p>
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

    <el-card v-if="pageTab === 'setup'" shadow="never" class="setup-intro">
      <div><span class="intro-kicker">从接入到业务操作</span><h2>把一个业务系统接给本地智能体</h2><p>选中下方应用，按顺序完成授权入口、系统说明和工具范围。连接、业务授权与实际执行分别检查。</p></div>
      <div class="intro-flow"><span>1 授权入口</span><i>→</i><span>2 系统说明</span><i>→</i><span>3 工具与审批</span><i>→</i><span>4 检查连接</span></div>
    </el-card>

    <el-card v-if="pageTab === 'setup'" shadow="never">
      <template #header>
        <div class="section-head">
          <div><b>业务系统接入</b><span>在一个入口完成本地智能体配置；授权记录与用量请切换到“设备与运行”。</span></div>
          <el-button size="small" @click="router.push('/clients')">新建接入方</el-button>
        </div>
      </template>
      <p v-if="pageRoute.query.workspace" class="muted">以下为允许使用工作空间 {{ pageRoute.query.workspace }} 的接入方，请选择要配置的应用。<el-button link @click="router.replace('/agent-clients')">显示全部</el-button></p>
      <el-empty v-if="!visibleApplications.length" description="当前没有匹配的接入方，请先创建接入方并关联工作空间。" />
      <el-table v-else :data="visibleApplications" size="small">
        <el-table-column label="应用" :width="180">
          <template #default="{ row }"><div class="stack"><b>{{ row.name || row.app_id }}</b><code>{{ row.app_id }}</code></div></template>
        </el-table-column>
        <el-table-column label="接入配置状态" :min-width="270">
          <template #default="{ row }">
            <div class="stack">
              <div><el-tag size="small" effect="plain" :type="connectionReady(row) ? 'success' : 'warning'">{{ connectionReady(row) ? '连接条件已配置' : '待完成配置' }}</el-tag></div>
              <span class="muted">{{ setupReason(row) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="工作空间" :width="180">
          <template #default="{ row }"><div class="tags"><el-tag v-for="route in previewRoutes(row.allowed_routes)" :key="route" size="small" effect="plain" type="info">{{ route }}</el-tag></div></template>
        </el-table-column>
        <el-table-column label="近期开销" :width="150" align="right">
          <template #default="{ row }"><div class="stack right"><span>{{ int(row.stats.runs) }} Run / {{ int(row.stats.tool_calls) }} 调用</span><span class="muted">{{ int(row.stats.total_tokens) }} Token</span></div></template>
        </el-table-column>
        <el-table-column :width="210" align="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" plain @click="openSetup(row)">配置接入</el-button>
            <el-tooltip :content="connectionReady(row) ? '复制公开连接信息，随后在客户端登录授权' : setupReason(row)"><span><el-button link :disabled="!connectionReady(row)" @click="openConnection(row)">连接配置</el-button></span></el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="pageTab === 'activity'" shadow="never">
      <template #header>
        <div class="section-head">
          <div><b>业务授权与设备</b><span>授权名称由业务系统同步；设备名称用于区分使用端。远程撤销后需要重新登录授权。</span></div>
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
      <el-table v-else v-loading="sessionsLoading" :data="sessions" size="small" row-key="session_id">
        <el-table-column label="授权名称" :min-width="180">
          <template #default="{ row }"><div class="stack"><b class="subject-name">{{ subjectName(row) || '待同步' }}</b><span class="muted">{{ subjectName(row) ? '业务系统提供' : '业务系统尚未提供名称' }}</span></div></template>
        </el-table-column>
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
        <el-table-column :width="130" align="right">
          <template #default="{ row }"><el-button link @click="sessionDetail = row">详情</el-button><el-button v-if="row.state !== 'revoked'" link type="danger" :loading="revoking === row.session_id" @click="revoke(row)">远程撤销</el-button><span v-else class="muted">已处理</span></template>
        </el-table-column>
      </el-table>
      <div v-if="sessionTotal > sessionPageSize" class="pagination">
        <el-pagination v-model:current-page="sessionPage" :page-size="sessionPageSize" :total="sessionTotal" layout="prev, pager, next, total" @current-change="loadSessions" />
      </div>
    </el-card>

    <el-dialog :model-value="Boolean(sessionDetail)" title="业务授权详情" width="min(640px, 94vw)" @update:model-value="value => { if (!value) sessionDetail = null; }">
      <template v-if="sessionDetail">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="授权名称"><span class="subject-name">{{ subjectName(sessionDetail) || '待同步' }}</span></el-descriptions-item>
          <el-descriptions-item label="名称来源">{{ subjectName(sessionDetail) ? '业务系统提供' : '业务系统尚未提供；旧授权可由原业务系统同步名称' }}</el-descriptions-item>
          <el-descriptions-item label="设备名称">{{ sessionDetail.device_label || '未命名设备' }}</el-descriptions-item>
          <el-descriptions-item label="接入应用"><code>{{ sessionDetail.client_app_id }}</code></el-descriptions-item>
          <el-descriptions-item label="授权记录"><code>{{ sessionDetail.session_id }}</code></el-descriptions-item>
          <el-descriptions-item label="业务主体">{{ sessionDetail.principal?.id || sessionDetail.on_behalf_of }}</el-descriptions-item>
          <el-descriptions-item label="租户">{{ sessionDetail.principal?.tenant || '未声明租户' }}</el-descriptions-item>
          <el-descriptions-item label="工作空间">{{ sessionDetail.allowed_routes.join('、') }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ stateText(sessionDetail.state) }}</el-descriptions-item>
        </el-descriptions>
        <p class="connection-note">名称只帮助识别授权。相同名称可能对应不同授权，权限、会话范围和执行记录仍按原授权绑定。名称更新不修改历史对话中的标签。</p>
      </template>
    </el-dialog>

    <AgentSetupPanel v-model="setup.open" :app-id="setup.appId" :initial-workspace="setup.workspace" :workspaces="setupWorkspaces" @saved="loadOverview" @connect="connectFromSetup" />

    <el-dialog v-model="connection.open" title="生成智能体客户端连接配置" width="620px">
      <el-alert type="info" :closable="false" show-icon title="这里只生成公开连接元数据，不包含业务 URL、业务身份、Client Token、Agent Token 或模型密钥。" />
      <p class="connection-note"><code>connectionName</code> 只是本机连接选择器。登录时会统一打开接入方配置的业务授权页，由该页面确认当前账号与租户。</p>
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
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import HelpTip from '../components/HelpTip.vue';
import AgentSetupPanel from '../components/AgentSetupPanel.vue';
import { kernelFetch, kernelOrigin } from '../runtime-path';

interface Workspace { route: string; name: string; description?: string }
interface SetupWorkspace extends Workspace { enabled: boolean; runtime_enabled: boolean; direct_enabled: boolean; source_count: number; system_info_configured: boolean }
interface Stats { runs: number; conversations: number; completed: number; failed: number; tool_calls: number; total_tokens: number; approvals: Record<string, number> }
interface Application { app_id: string; name: string; enabled: boolean; agent_auth_enabled: boolean; agent_authorize_url?: string | null; allowed_routes: string[]; last_used_at?: string | null; stats: Stats }
interface SessionRow { subject_display?: { name: string } | null; subject_display_status?: 'provided' | 'missing'; session_id: string; client_app_id: string; device_label: string; principal?: { id?: string; tenant?: string; roles?: string[] }; on_behalf_of: string; allowed_routes: string[]; last_seen_at?: string; refresh_expires_at: string; state: 'active' | 'expired' | 'revoked' }

const router = useRouter();
const pageRoute = useRoute();
const pageTab = ref('setup');
const days = ref(30);
const loading = ref(false);
const sessionsLoading = ref(false);
const revoking = ref('');
const applications = ref<Application[]>([]);
const visibleApplications = computed(() => {
  const workspace = pageRoute.query.workspace;
  return typeof workspace === 'string' ? applications.value.filter((app) => app.allowed_routes.includes('*') || app.allowed_routes.includes(workspace)) : applications.value;
});
const workspaces = ref<Workspace[]>([]);
const setupWorkspaces = ref<SetupWorkspace[]>([]);
const setup = reactive({ open: false, appId: '', workspace: '' });
const sessions = ref<SessionRow[]>([]);
const sessionDetail = ref<SessionRow | null>(null);
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

function subjectName(row: SessionRow): string {
  const name = row.subject_display?.name;
  return row.subject_display_status === 'provided' && typeof name === 'string' ? name : '';
}
function quote(value: string): string { return JSON.stringify(value); }
function int(value: unknown): string { return new Intl.NumberFormat('zh-CN').format(Number(value || 0)); }
function percent(value: unknown): string { return `${(Number(value || 0) * 100).toFixed(1)}%`; }
function shortId(value: string): string { return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : '—'; }
function fmtTime(value?: string | null): string { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '从未'; }
function stateText(value: SessionRow['state']): string { return value === 'active' ? '有效' : value === 'expired' ? '已过期' : '已撤销'; }
function stateType(value: SessionRow['state']): 'success' | 'warning' | 'info' { return value === 'active' ? 'success' : value === 'expired' ? 'warning' : 'info'; }
function previewRoutes(routes: string[]): string[] { return routes.includes('*') ? ['全部 Workspace'] : routes.slice(0, 4); }
function allowedWorkspaces(app: Application): SetupWorkspace[] { return setupWorkspaces.value.filter((workspace) => app.allowed_routes.includes('*') || app.allowed_routes.includes(workspace.route)); }
function eligibleWorkspaces(app: Application): Workspace[] { return allowedWorkspaces(app).filter((workspace) => workspace.enabled && workspace.runtime_enabled); }
function connectionReady(app: Application): boolean { return app.enabled && app.agent_auth_enabled && eligibleWorkspaces(app).length > 0; }
function setupReason(app: Application): string {
  if (!app.enabled) return '接入方已停用，需先恢复接入';
  if (!app.agent_auth_enabled) return '尚未配置业务授权入口';
  const choices = allowedWorkspaces(app);
  if (!choices.length) return '尚未关联现有工作空间';
  const active = choices.filter((w) => w.enabled && w.runtime_enabled);
  if (!active.length) return '尚无已启用本地智能体的工作空间';
  if (!active.some((w) => w.direct_enabled)) return '连接入口已准备好；业务工具调用尚未开启';
  if (!active.some((w) => w.direct_enabled && w.source_count)) return '工具通道已开启；尚需配置业务工具源';
  if (active.some((w) => !w.system_info_configured)) return '建议补充系统说明，帮助智能体首次选择目标';
  return '连接与工具通道已配置；实际可用动作以业务授权为准';
}
function openSetup(app: Application, workspace = ''): void { setup.appId = app.app_id; setup.workspace = workspace; setup.open = true; }
function connectFromSetup(value: { app_id: string; workspace: string }): void {
  const app = applications.value.find((item) => item.app_id === value.app_id); if (!app) return;
  openConnection(app); connection.workspace = value.workspace;
}

async function loadOverview(): Promise<void> {
  loading.value = true;
  try {
    const response = await kernelFetch(`/admin/api/agent-clients/overview?days=${days.value}`);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '加载失败');
    const data = await response.json();
    applications.value = data.applications || [];
    workspaces.value = data.workspaces || [];
    setupWorkspaces.value = data.setup_workspaces || [];
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

onMounted(async () => {
  await refreshAll();
  const key = typeof pageRoute.query.workspace === 'string' ? pageRoute.query.workspace : '';
  const appId = typeof pageRoute.query.app === 'string' ? pageRoute.query.app : '';
  const matching = applications.value.filter((app) => appId ? app.app_id === appId : key && (app.allowed_routes.includes('*') || app.allowed_routes.includes(key)));
  if (matching.length === 1) openSetup(matching[0]!, key);
});
</script>

<style scoped>
.agent-clients-page { display: grid; gap: 16px; }
.page-navigation{display:flex;justify-content:space-between;align-items:center;gap:16px}.page-navigation b{font-size:20px}.page-navigation span{display:block;font-size:13px;color:var(--el-text-color-secondary);margin-top:7px}
.setup-intro{border-color:var(--el-color-primary-light-7);background:linear-gradient(120deg,var(--el-color-primary-light-9),var(--el-bg-color) 70%)}
.intro-kicker{font-size:12px;color:var(--el-color-primary);font-weight:600}.setup-intro h2{font-size:21px;margin:8px 0 10px}.setup-intro p{font-size:13px;color:var(--el-text-color-secondary);line-height:1.7;margin:0}.intro-flow{display:flex;flex-wrap:wrap;align-items:center;gap:16px;margin-top:22px;font-size:13px}.intro-flow span{padding:7px 11px;background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:6px}.intro-flow i{font-style:normal;color:var(--el-text-color-placeholder)}
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
.subject-name { overflow-wrap: anywhere; white-space: pre-wrap; }
.stack.right { align-items: flex-end; }
.mono, code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.connection-form { margin-top: 18px; }
.connection-note { margin: 12px 0 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.pagination { display: flex; justify-content: flex-end; padding-top: 14px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.code-block { margin-top: 10px; padding: 12px; overflow: auto; border-radius: 8px; background: #111827; color: #e5e7eb; }
.code-block pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 12px; }
@media (max-width: 1280px) { .overview { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 760px) { .overview, .form-grid { grid-template-columns: 1fr; } .head, .section-head { align-items: flex-start; flex-direction: column; } }
</style>
