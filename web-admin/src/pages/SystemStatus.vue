<template>
  <el-card shadow="never">
    <template #header>
      <div class="head">
        <b>系统状态</b> <HelpTip title="系统状态是什么">
          <p>展示当前中枢代码版本、运行时、数据库迁移账本、对外契约版本和配置体检结果。</p>
          <p>如果存在未应用数据库结构，应先执行部署流程里的 <code>npm run db:init</code>，再重启服务。</p>
          <p>配置体检会检查路由、目标、接入方、渠道、工具源、知识库、执行器令牌、工具源授权探针等跨配置引用，帮助定位“能保存但跑不通”的问题。</p>
        </HelpTip>
        <el-button size="small" :loading="loading" style="margin-left: auto" @click="load">刷新</el-button>
      </div>
    </template>

    <div v-loading="loading">
      <el-alert
        v-if="data?.migrations.pending.length"
        type="warning"
        :closable="false"
        show-icon
        title="存在未应用数据库结构"
        :description="data.migrations.pending.join(', ')"
        style="margin-bottom: 14px" />
      <div v-else-if="data" class="field-hint">数据库结构已匹配当前代码。</div>
      <el-alert
        v-if="diag && !diag.ok"
        class="statusAlert"
        :type="diag.errors ? 'error' : 'warning'"
        :closable="false"
        show-icon
        :title="`配置体检：${diag.errors} 个错误 / ${diag.warnings} 个提醒`"
        description="错误项通常会导致对应路由、入口或执行器不可用；提醒项不一定阻断运行，但建议在开源示例和生产部署中清理。"
        style="margin-bottom: 14px" />
      <div v-else-if="diag" class="field-hint">配置体检通过：未发现错误或提醒。</div>

      <div class="statusGrid">
        <div class="statusBox">
          <span class="muted">应用</span>
          <b><code>{{ data?.app.name }}</code></b>
          <em>版本 {{ data?.app.version || '—' }} · Node {{ data?.runtime.node || '—' }}</em>
        </div>
        <div class="statusBox">
          <span class="muted">数据库结构</span>
          <b><code>{{ data?.migrations.applied ?? 0 }} / {{ data?.migrations.total ?? 0 }}</code></b>
          <em>最新 {{ data?.migrations.latest || '—' }}</em>
        </div>
        <div class="statusBox">
          <span class="muted">最新已应用</span>
          <b><code>{{ data?.migrations.latest_applied || '—' }}</code></b>
          <em>{{ data?.migrations.pending.length ? `${data.migrations.pending.length} 个待应用` : '账本已同步' }}</em>
        </div>
      </div>

      <div class="sub">契约版本</div>
      <el-table :data="contractRows" size="small" empty-text="无数据">
        <el-table-column prop="name" label="契约" min-width="180" show-overflow-tooltip />
        <el-table-column prop="version" label="版本" width="180"><template #default="{ row }"><code>{{ row.version }}</code></template></el-table-column>
      </el-table>

      <div class="sub">配置体检</div>
      <el-table :data="diag?.diagnostics ?? []" size="small" empty-text="未发现问题" max-height="360">
        <el-table-column label="级别" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.severity === 'error' ? 'danger' : 'warning'" effect="plain">{{ row.severity === 'error' ? '错误' : '提醒' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对象" width="190" show-overflow-tooltip>
          <template #default="{ row }"><code>{{ areaLabel(row.area) }}:{{ row.id }}</code></template>
        </el-table-column>
        <el-table-column prop="message" label="问题" min-width="360" show-overflow-tooltip />
      </el-table>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../request';
import HelpTip from '../components/HelpTip.vue';

interface VersionInfo {
  app: { name: string; version: string };
  runtime: { node: string };
  contracts: Record<string, string>;
  migrations: {
    latest: string | null;
    total: number;
    applied: number;
    latest_applied: string | null;
    pending: string[];
  };
}
interface ConfigDiagnostic {
  severity: 'error' | 'warning';
  area: string;
  id: string;
  message: string;
}
interface ConfigDiagnosticsReport {
  ok: boolean;
  errors: number;
  warnings: number;
  diagnostics: ConfigDiagnostic[];
}

const data = ref<VersionInfo | null>(null);
const diag = ref<ConfigDiagnosticsReport | null>(null);
const loading = ref(false);

const contractRows = computed(() => Object.entries(data.value?.contracts ?? {}).map(([name, version]) => ({ name, version })));

function areaLabel(area: string): string {
  const labels: Record<string, string> = {
    route: '触发路由',
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

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [version, diagnostics] = await Promise.all([
      api<VersionInfo>('/admin/api/version'),
      api<ConfigDiagnosticsReport>('/admin/api/config-diagnostics'),
    ]);
    data.value = version;
    diag.value = diagnostics;
  }
  finally { loading.value = false; }
}

onMounted(load);
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.statusGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
.statusBox { border: 1px solid var(--el-border-color-lighter); padding: 10px 12px; background: var(--el-fill-color-light); min-width: 0; }
.statusBox span, .statusBox b, .statusBox em { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.statusBox b { margin-top: 4px; font-size: 14px; }
.statusBox em { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 12px; font-style: normal; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.sub { font-size: 13px; font-weight: 600; margin: 12px 0 6px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.statusAlert {
  margin-bottom: 14px;
  border-left: 3px solid var(--el-color-danger);
}
.statusAlert :deep(.el-alert__content) {
  display: grid;
  gap: 2px;
  padding: 0 2px;
}
.statusAlert :deep(.el-alert__title) {
  font-size: 15px;
  line-height: 1.5;
  font-weight: 650;
}
.statusAlert :deep(.el-alert__description) {
  margin: 0;
  font-size: 12px;
  line-height: 1.65;
}
.statusAlert :deep(.el-alert__icon) {
  width: 20px;
  font-size: 20px;
}
@media (max-width: 900px) {
  .statusGrid { grid-template-columns: 1fr; }
}
</style>
