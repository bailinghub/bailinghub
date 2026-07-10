<template>
  <el-card shadow="never">
    <template #header>
      <div class="head">
        <span><b>系统体检</b> <HelpTip title="系统体检是什么">
          <p>把配置结构、跨表引用、Audience、route=auto、工具源授权探针等隐性风险集中展示。</p>
          <p>分诊预演使用和真实 <code>/run route=auto</code> 相同的规则，只预览不建单。</p>
        </HelpTip></span>
        <div class="headActions">
          <el-button size="small" :loading="smokeLoading" @click="runSmoke">运行 smoke</el-button>
          <el-button size="small" :loading="loading" @click="load">刷新</el-button>
        </div>
      </div>
    </template>

    <el-tabs v-model="tab">
      <el-tab-pane label="配置体检" name="diagnostics">
        <div class="summary">
          <div><span class="muted">状态</span><b :class="{ bad: diag && !diag.ok }">{{ diag?.ok ? '通过' : '存在问题' }}</b></div>
          <div><span class="muted">错误</span><b>{{ diag?.errors ?? 0 }}</b></div>
          <div><span class="muted">提醒</span><b>{{ diag?.warnings ?? 0 }}</b></div>
          <div><span class="muted">问题对象</span><b>{{ grouped.length }}</b></div>
        </div>
        <div class="checkGrid">
          <div v-for="c in checkCards" :key="c.key" class="checkCard" :class="c.status">
            <div class="checkTop">
              <b>{{ c.title }}</b>
              <el-tag size="small" effect="plain" :type="statusTag(c.status)">{{ statusLabel(c.status) }}</el-tag>
            </div>
            <div class="muted">{{ c.detail }}</div>
            <el-button v-if="c.to" link type="primary" size="small" @click="router.push(c.to)">定位</el-button>
          </div>
        </div>
        <div v-if="smoke" class="smokePanel">
          <div class="smokeHead">
            <b>Smoke 结果</b>
            <span class="muted mono">{{ smoke.hub }}</span>
            <el-tag size="small" effect="plain" :type="smoke.fail ? 'danger' : 'success'">通过 {{ smoke.pass }} / 跳过 {{ smoke.skip }} / 失败 {{ smoke.fail }}</el-tag>
            <el-button v-if="smoke.run?.job_id" link type="primary" size="small" @click="router.push({ path: '/runs', query: { job: smoke.run.job_id } })">查看 smoke 任务</el-button>
          </div>
          <el-table :data="smoke.checks" size="small">
            <el-table-column label="状态" width="80" align="center">
              <template #default="{ row }"><el-tag size="small" effect="plain" :type="smokeTag(row.status)">{{ smokeLabel(row.status) }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="name" label="检查项" min-width="220" />
            <el-table-column prop="detail" label="说明" min-width="260" show-overflow-tooltip />
          </el-table>
        </div>
        <div class="toolbar">
          <el-segmented v-model="severity" :options="severityOptions" size="small" />
          <el-input v-model="keyword" size="default" clearable placeholder="搜索对象 / 问题" class="search" />
        </div>
        <el-empty v-if="!loading && !filtered.length" description="未发现匹配的问题" />
        <div v-else v-loading="loading" class="groups">
          <section v-for="g in grouped" :key="g.area" class="group">
            <div class="groupHead">
              <b>{{ areaLabel(g.area) }}</b>
              <el-tag size="small" effect="plain" type="danger">{{ g.errors }} 错误</el-tag>
              <el-tag size="small" effect="plain" type="warning">{{ g.warnings }} 提醒</el-tag>
            </div>
            <el-table :data="g.items" size="small">
              <el-table-column label="级别" width="80" align="center">
                <template #default="{ row }"><el-tag :type="row.severity === 'error' ? 'danger' : 'warning'" effect="plain">{{ row.severity === 'error' ? '错误' : '提醒' }}</el-tag></template>
              </el-table-column>
              <el-table-column label="对象" width="220" show-overflow-tooltip>
                <template #default="{ row }"><code>{{ row.id }}</code></template>
              </el-table-column>
              <el-table-column prop="message" label="问题" min-width="360" show-overflow-tooltip />
              <el-table-column label="定位" width="90" align="right">
                <template #default="{ row }"><el-button link type="primary" @click="goto(row)">打开</el-button></template>
              </el-table-column>
            </el-table>
          </section>
        </div>
      </el-tab-pane>

      <el-tab-pane label="route=auto 预演" name="auto">
        <div class="previewForm">
          <el-form label-position="top" @submit.prevent>
            <el-row :gutter="12">
              <el-col :span="8">
                <el-form-item label="接入方">
                  <el-select v-model="preview.client_app_id" clearable filterable size="default" placeholder="不选则按 admin 预演">
                    <el-option v-for="c in clients" :key="c.app_id" :label="`${c.name} (${c.app_id})`" :value="c.app_id" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="主体 ID">
                  <el-input v-model="preview.principal.id" size="default" placeholder="如 u-1001" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="租户">
                  <el-input v-model="preview.principal.tenant" size="default" placeholder="如 t-1" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-row :gutter="12">
              <el-col :span="8">
                <el-form-item label="角色">
                  <el-input v-model="preview.rolesText" size="default" placeholder="逗号分隔，如 cs,ops" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="受众">
                  <el-input v-model="preview.principal.audience" size="default" placeholder="如 employee / customer" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="渠道">
                  <el-input v-model="preview.channel" size="default" placeholder="默认接入方或 admin" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-form-item label="触发文本">
              <el-input v-model="preview.input" type="textarea" size="default" :rows="3" placeholder="输入业务侧将传给 /run 的 input" />
            </el-form-item>
            <el-form-item label="metadata JSON">
              <el-input v-model="preview.metadataText" type="textarea" size="default" :rows="4" class="mono" placeholder='{"record_id":"1001"}' />
            </el-form-item>
            <el-button type="primary" :loading="previewLoading" @click="runPreview">开始预演</el-button>
          </el-form>
        </div>

        <div v-if="previewResult" class="previewResult">
          <div class="resultHead">
            <el-tag :type="previewResult.ok ? 'success' : 'warning'" effect="plain">{{ previewResult.ok ? '可命中' : '未选中' }}</el-tag>
            <b v-if="previewResult.selected_route" class="mono">{{ previewResult.selected_route }}</b>
            <span v-if="previewResult.error" class="muted mono">{{ previewResult.error }}</span>
          </div>
          <el-table :data="previewResult.rows" size="small" max-height="440">
            <el-table-column label="路由" min-width="180" show-overflow-tooltip>
              <template #default="{ row }">
                <el-tag v-if="row.selected" size="small" type="success" effect="plain">选中</el-tag>
                <code>{{ row.route_key }}</code>
              </template>
            </el-table-column>
            <el-table-column label="得分" width="80" align="center"><template #default="{ row }">{{ row.score }}</template></el-table-column>
            <el-table-column label="命中原因" min-width="180" show-overflow-tooltip>
              <template #default="{ row }">{{ row.reasons?.join(' / ') || '—' }}</template>
            </el-table-column>
            <el-table-column label="过滤原因" min-width="170" show-overflow-tooltip>
              <template #default="{ row }"><span class="muted mono">{{ row.rejected_reason || '—' }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="180">
              <template #default="{ row }">
                <el-tag size="small" effect="plain" :type="row.enabled ? 'success' : 'info'">route</el-tag>
                <el-tag size="small" effect="plain" :type="row.auto_enabled ? 'success' : 'info'">auto</el-tag>
                <el-tag size="small" effect="plain" :type="row.client_allowed ? 'success' : 'danger'">client</el-tag>
                <el-tag size="small" effect="plain" :type="row.audience_allowed ? 'success' : 'danger'">audience</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus/es/components/message/index';
import { api } from '../request';
import HelpTip from '../components/HelpTip.vue';

interface ConfigDiagnostic { severity: 'error' | 'warning'; area: string; id: string; message: string }
interface ConfigDiagnosticsReport { ok: boolean; errors: number; warnings: number; diagnostics: ConfigDiagnostic[] }
interface ClientRow { app_id: string; name: string }
type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip' | 'idle';
interface SmokeCheck { name: string; status: 'pass' | 'fail' | 'skip'; detail?: string }
interface SmokeReport {
  hub: string;
  pass: number;
  fail: number;
  skip: number;
  checks: SmokeCheck[];
  run?: { route?: string; request_id?: string; job_id?: string; status?: string };
}

const router = useRouter();
const tab = ref<'diagnostics' | 'auto'>('diagnostics');
const loading = ref(false);
const diag = ref<ConfigDiagnosticsReport | null>(null);
const clients = ref<ClientRow[]>([]);
const smoke = ref<SmokeReport | null>(null);
const smokeLoading = ref(false);
const severity = ref<'all' | 'error' | 'warning'>('all');
const keyword = ref('');
const severityOptions = [
  { label: '全部', value: 'all' },
  { label: '错误', value: 'error' },
  { label: '提醒', value: 'warning' },
];

const preview = reactive({
  client_app_id: '',
  channel: '',
  input: '',
  rolesText: '',
  metadataText: '{}',
  principal: { id: '', tenant: '', audience: '' },
});
const previewLoading = ref(false);
const previewResult = ref<any | null>(null);

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  return (diag.value?.diagnostics ?? []).filter((d) => {
    if (severity.value !== 'all' && d.severity !== severity.value) return false;
    if (!q) return true;
    return [d.area, d.id, d.message].join(' ').toLowerCase().includes(q);
  });
});
const grouped = computed(() => {
  const map = new Map<string, ConfigDiagnostic[]>();
  for (const d of filtered.value) map.set(d.area, [...(map.get(d.area) ?? []), d]);
  return Array.from(map.entries()).map(([area, items]) => ({
    area,
    items,
    errors: items.filter((d) => d.severity === 'error').length,
    warnings: items.filter((d) => d.severity === 'warning').length,
  })).sort((a, b) => b.errors - a.errors || b.warnings - a.warnings || areaLabel(a.area).localeCompare(areaLabel(b.area)));
});
const checkCards = computed(() => {
  const diags = diag.value?.diagnostics ?? [];
  const runtimeIssues = diags.filter((d) => d.area.startsWith('runtime_'));
  const configErrors = diags.filter((d) => d.severity === 'error' && !d.area.startsWith('runtime_')).length;
  const autoIssues = diags.filter((d) => d.area === 'route_auto');
  const dlqIssues = diags.filter((d) => d.area === 'runtime_delivery');
  const smokeRun = smoke.value?.checks.find((c) => c.name.includes('/run + trace') || c.name.includes('/run 建单'));
  const smokeFailures = smoke.value?.fail ?? 0;
  return [
    {
      key: 'config',
      title: '配置结构',
      status: !diag.value ? 'idle' : configErrors ? 'fail' : 'pass',
      detail: !diag.value ? '等待体检数据' : configErrors ? `${configErrors} 个配置错误需要先修复` : '路由、目标、接入方、工具源等结构可用',
      to: configErrors ? '/routes' : '',
    },
    {
      key: 'runtime',
      title: '运行期调度',
      status: runtimeIssues.some((d) => d.severity === 'error') ? 'fail' : runtimeIssues.length ? 'warn' : diag.value ? 'pass' : 'idle',
      detail: runtimeIssues.length ? `${runtimeIssues.length} 个队列、执行器或送达运行期风险` : '队列、租约、执行器覆盖和送达队列未发现异常',
      to: runtimeIssues.length ? '/executors' : '',
    },
    {
      key: 'auto',
      title: 'route=auto',
      status: autoIssues.some((d) => d.severity === 'error') ? 'fail' : autoIssues.length ? 'warn' : diag.value ? 'pass' : 'idle',
      detail: autoIssues.length ? `${autoIssues.length} 个自动分诊规则需要确认` : '自动分诊规则未发现冲突或过宽风险',
      to: autoIssues.length ? '/routes' : '',
    },
    {
      key: 'delivery',
      title: '送达死信',
      status: dlqIssues.some((d) => d.severity === 'error') ? 'fail' : dlqIssues.length ? 'warn' : diag.value ? 'pass' : 'idle',
      detail: dlqIssues.length ? '存在未处理送达死信或送达风险' : '未发现未处理送达死信',
      to: dlqIssues.length ? '/runs' : '',
    },
    {
      key: 'smoke',
      title: 'E2E Smoke',
      status: !smoke.value ? 'idle' : smokeFailures ? 'fail' : 'pass',
      detail: !smoke.value ? '点击运行 smoke，检查公网入口、后台 API、schema 和 demo 闭环' : `通过 ${smoke.value.pass}，跳过 ${smoke.value.skip}，失败 ${smoke.value.fail}`,
      to: smoke.value?.run?.job_id ? `/runs?job=${smoke.value.run.job_id}` : '',
    },
    {
      key: 'demo',
      title: 'Demo 闭环',
      status: !smoke.value || !smokeRun ? 'idle' : smokeRun.status === 'pass' ? 'pass' : smokeRun.status === 'skip' ? 'skip' : 'fail',
      detail: !smoke.value ? '未运行 smoke' : smoke.value.run?.job_id ? `已创建任务 ${smoke.value.run.job_id}` : '当前环境未检测到 demo route 或 demo token',
      to: smoke.value?.run?.job_id ? `/runs?job=${smoke.value.run.job_id}` : '',
    },
  ] as Array<{ key: string; title: string; status: CheckStatus; detail: string; to: string }>;
});

function areaLabel(area: string): string {
  const labels: Record<string, string> = {
    route: '触发路由',
    route_audience: '路由受众',
    route_auto: '自动分诊',
    target: '调度目标',
    project: '项目目录',
    client: '接入方',
    channel: '入站渠道',
    alert_rule: '告警规则',
    tool_provider: '工具源',
    storage_bucket: '对象存储',
    chat_entry: '聊天入口',
    executor_token: '执行器令牌',
    kb_base: '知识库',
    runtime_dispatch: '调度运行时',
    runtime_executor: '执行器运行时',
    runtime_jobs: '任务运行时',
    runtime_delivery: '送达运行时',
    system: '系统',
  };
  return labels[area] ?? area;
}
function pageFor(area: string): string {
  if (area === 'route' || area === 'route_audience' || area === 'route_auto') return '/routes';
  if (area === 'client') return '/clients';
  if (area === 'channel') return '/channels';
  if (area === 'tool_provider') return '/tools';
  if (area === 'storage_bucket') return '/storage';
  if (area === 'chat_entry') return '/chat';
  if (area === 'executor_token') return '/executors';
  if (area === 'target') return '/targets';
  if (area === 'project') return '/projects';
  if (area === 'kb_base') return '/kb';
  if (area === 'runtime_dispatch' || area === 'runtime_executor' || area === 'runtime_jobs') return '/executors';
  if (area === 'runtime_delivery') return '/runs';
  return '/system';
}
function goto(row: ConfigDiagnostic): void {
  void router.push({ path: pageFor(row.area), query: { q: row.id } });
}
function parseMetadata(): Record<string, unknown> {
  const raw = preview.metadataText.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('metadata 必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}
async function runPreview(): Promise<void> {
  if (!preview.input.trim()) { ElMessage.error('请输入触发文本'); return; }
  previewLoading.value = true;
  try {
    const metadata = parseMetadata();
    const roles = preview.rolesText.split(',').map((x) => x.trim()).filter(Boolean);
    previewResult.value = await api('/admin/api/routes/auto-preview', {
      method: 'POST',
      body: JSON.stringify({
        input: preview.input,
        client_app_id: preview.client_app_id || undefined,
        channel: preview.channel || undefined,
        metadata,
        principal: {
          ...(preview.principal.id ? { id: preview.principal.id } : {}),
          ...(preview.principal.tenant ? { tenant: preview.principal.tenant } : {}),
          ...(roles.length ? { roles } : {}),
          ...(preview.principal.audience ? { audience: preview.principal.audience } : {}),
        },
      }),
    });
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally { previewLoading.value = false; }
}
async function load(): Promise<void> {
  loading.value = true;
  try {
    const [d, c] = await Promise.all([
      api<ConfigDiagnosticsReport>('/admin/api/config-diagnostics'),
      api<ClientRow[]>('/admin/api/clients').catch(() => []),
    ]);
    diag.value = d;
    clients.value = c;
  } finally { loading.value = false; }
}
async function runSmoke(): Promise<void> {
  smokeLoading.value = true;
  try {
    smoke.value = await api<SmokeReport>('/admin/api/smoke', { method: 'POST', body: '{}' });
    if (smoke.value.fail) ElMessage.warning(`Smoke 完成：${smoke.value.fail} 项失败`);
    else ElMessage.success('Smoke 通过');
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally { smokeLoading.value = false; }
}
function statusTag(s: CheckStatus): 'success' | 'danger' | 'info' | 'warning' {
  if (s === 'pass') return 'success';
  if (s === 'fail') return 'danger';
  if (s === 'warn') return 'warning';
  return 'info';
}
function statusLabel(s: CheckStatus): string {
  if (s === 'pass') return '通过';
  if (s === 'fail') return '失败';
  if (s === 'warn') return '提醒';
  if (s === 'skip') return '跳过';
  return '未运行';
}
function smokeTag(s: SmokeCheck['status']): 'success' | 'danger' | 'info' {
  return s === 'pass' ? 'success' : s === 'fail' ? 'danger' : 'info';
}
function smokeLabel(s: SmokeCheck['status']): string {
  return s === 'pass' ? '通过' : s === 'fail' ? '失败' : '跳过';
}

onMounted(load);
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.headActions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
.summary > div { border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 9px 11px; background: var(--el-fill-color-light); }
.summary span, .summary b { display: block; }
.summary b { margin-top: 3px; font-size: 14px; }
.bad { color: var(--el-color-danger); }
.checkGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
.checkCard { border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 10px 12px; background: var(--el-fill-color-blank); min-height: 86px; }
.checkCard.pass { border-color: var(--el-color-success-light-7); }
.checkCard.fail { border-color: var(--el-color-danger-light-7); }
.checkCard.warn { border-color: var(--el-color-warning-light-7); }
.checkTop { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.smokePanel { border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 10px 12px; margin-bottom: 12px; }
.smokeHead { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.search { max-width: 320px; }
.groups { display: flex; flex-direction: column; gap: 14px; }
.group { border: 1px solid var(--el-border-color-lighter); border-radius: 0; overflow: hidden; }
.groupHead { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: var(--el-fill-color-light); border-bottom: 1px solid var(--el-border-color-lighter); }
.previewForm { max-width: 980px; }
.previewForm :deep(.el-input__wrapper),
.previewForm :deep(.el-select__wrapper) {
  min-height: 32px;
  padding: 4px 12px;
  font-size: 13px;
}
.previewForm :deep(.el-textarea__inner) {
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.7;
}
.previewResult { margin-top: 16px; }
.resultHead { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono, code { font-family: var(--bz-mono); font-size: 12px; }
@media (max-width: 900px) {
  .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .checkGrid { grid-template-columns: repeat(1, minmax(0, 1fr)); }
  .toolbar { align-items: stretch; flex-direction: column; }
  .search { max-width: none; }
}
</style>
