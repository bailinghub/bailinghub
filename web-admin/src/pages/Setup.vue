<template>
  <div class="setup">
    <el-card shadow="never" class="panel">
      <template #header>
        <div class="head">
          <span><b>上手向导</b> <HelpTip title="上手向导是什么">
            <p>把第一次接入需要完成的配置按真实运行链路串起来：模型凭证、调度目标、工具源、接入方、触发路由、Smoke 验证。</p>
            <p>这里不替代各配置页，只负责告诉开发者当前缺哪一环，并提供直接跳转。</p>
          </HelpTip></span>
          <div class="headActions">
            <el-button size="small" @click="openDocs">开发文档</el-button>
            <el-button v-if="demoAvailable" size="small" type="primary" :loading="demoLoading" @click="importDemo">导入演示数据</el-button>
            <el-button v-if="demoAvailable && demoStatus?.imported" size="small" :loading="demoCleanupLoading" @click="clearDemo">清理演示数据</el-button>
            <el-button size="small" :loading="smokeLoading" @click="runSmoke">运行 smoke</el-button>
            <el-button size="small" :loading="loading" @click="load">刷新</el-button>
          </div>
        </div>
      </template>

      <div class="summary">
        <div>
          <span class="muted">配置完成度</span>
          <b>{{ passedSteps }}/{{ steps.length }}</b>
        </div>
        <div>
          <span class="muted">接入方</span>
          <b>{{ clients.length }}</b>
        </div>
        <div>
          <span class="muted">触发路由</span>
          <b>{{ routes.length }}</b>
        </div>
        <div>
          <span class="muted">工具源</span>
          <b>{{ providers.length }}</b>
        </div>
      </div>

      <div class="nextPanel">
        <div class="nextMain">
          <span class="muted">下一步</span>
          <b>{{ demoAvailable && demoStatus?.imported ? '演示数据已导入' : demoAvailable && demoStatus?.empty ? '导入演示数据' : (nextStep?.title || '基础链路已完成') }}</b>
          <p>{{ demoAvailable && demoStatus?.imported ? '可以继续刷新演示数据；准备正式接入时，可一键清理中枢内置的演示配置与演示运行记录。' : demoAvailable && demoStatus?.empty ? '当前实例还没有配置。先导入一套演示数据，可以直接看到路由、工具、任务、审批和成本页面如何协同。' : (nextStep?.detail || '可以运行 smoke 或使用真实业务系统触发 /run，继续观察 trace、审批、送达和成本。') }}</p>
        </div>
        <div class="nextActions">
          <el-button v-if="demoAvailable" type="primary" :loading="demoLoading" @click="importDemo">{{ demoStatus?.imported ? '刷新演示数据' : '导入演示数据' }}</el-button>
          <el-button v-if="demoAvailable && demoStatus?.imported" :loading="demoCleanupLoading" @click="clearDemo">清理演示数据</el-button>
          <el-button v-if="nextStep" type="primary" @click="router.push(nextStep.path)">处理 {{ nextStep.title }}</el-button>
          <el-button :loading="smokeLoading" @click="runSmoke">运行 smoke</el-button>
          <el-button @click="openDocs">开发文档</el-button>
        </div>
      </div>

      <div class="steps">
        <section v-for="s in steps" :key="s.key" class="step" :class="s.status">
          <div class="stepTop">
            <span class="num">{{ s.index }}</span>
            <b>{{ s.title }}</b>
            <el-tag size="small" effect="plain" :type="tagType(s.status)">{{ statusLabel(s.status) }}</el-tag>
          </div>
          <p>{{ s.detail }}</p>
          <div class="actions">
            <el-button size="small" @click="router.push(s.path)">打开{{ s.title }}</el-button>
            <el-button v-if="s.doc" link type="primary" size="small" @click="openDocPath(s.doc)">文档</el-button>
          </div>
        </section>
      </div>
    </el-card>

    <div class="guideGrid" :class="{ single: !smoke }">
      <el-card shadow="never" class="panel">
        <template #header><div class="head"><b>推荐接入路径</b></div></template>
        <el-timeline>
          <el-timeline-item timestamp="1" type="primary">
            在业务系统暴露 OpenAPI 工具清单，并给 Agent 可调接口补充 <code>x-agent-capability</code> 能力声明。
          </el-timeline-item>
          <el-timeline-item timestamp="2" type="primary">
            在中枢注册工具源、接入方和触发路由，把“谁能触发什么场景、能用哪些工具”装配清楚。
          </el-timeline-item>
          <el-timeline-item timestamp="3" type="primary">
            使用 smoke 或真实 <code>/run</code> 建单，确认 trace、审批意图、工具调用和结果回传都可观测。
          </el-timeline-item>
        </el-timeline>
      </el-card>

      <el-card v-if="smoke" shadow="never" class="panel">
        <template #header>
          <div class="head">
            <b>Smoke 结果</b>
            <el-button size="small" :loading="smokeLoading" @click="runSmoke">重新运行</el-button>
          </div>
        </template>
        <div class="smoke">
          <div class="smokeMeta">
            <el-tag effect="plain" :type="smoke.fail ? 'danger' : 'success'">通过 {{ smoke.pass }} / 跳过 {{ smoke.skip }} / 失败 {{ smoke.fail }}</el-tag>
            <span class="mono muted">{{ smoke.hub }}</span>
            <el-button v-if="smoke.run?.job_id" link type="primary" @click="router.push({ path: '/runs', query: { job: smoke.run.job_id } })">查看任务</el-button>
          </div>
          <el-table :data="smoke.checks" size="small" max-height="260">
            <el-table-column label="状态" width="78" align="center">
              <template #default="{ row }"><el-tag size="small" effect="plain" :type="tagType(row.status)">{{ statusLabel(row.status) }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="name" label="检查项" min-width="150" show-overflow-tooltip />
            <el-table-column prop="detail" label="说明" min-width="180" show-overflow-tooltip />
          </el-table>
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import { api } from '../request';
import { openDoc } from '../docs';
import HelpTip from '../components/HelpTip.vue';

type StepStatus = 'pass' | 'warn' | 'fail' | 'skip' | 'idle';
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
const loading = ref(false);
const smokeLoading = ref(false);
const credentials = ref<any[]>([]);
const targets = ref<any[]>([]);
const providers = ref<any[]>([]);
const clients = ref<any[]>([]);
const routes = ref<any[]>([]);
const smoke = ref<SmokeReport | null>(null);
const demoStatus = ref<any | null>(null);
const demoLoading = ref(false);
const demoCleanupLoading = ref(false);
const demoAvailable = computed(() => demoStatus.value?.available === true);

async function safeList<T = any>(path: string): Promise<T[]> {
  try {
    const r = await api<T[]>(path);
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [cs, ts, ps, cls, rs, ds] = await Promise.all([
      safeList('/admin/api/credentials'),
      safeList('/admin/api/targets'),
      safeList('/admin/api/tool-providers'),
      safeList('/admin/api/clients'),
      safeList('/admin/api/routes'),
      api<any>('/admin/api/demo-dataset/status').catch(() => null),
    ]);
    credentials.value = cs;
    targets.value = ts;
    providers.value = ps;
    clients.value = cls;
    routes.value = rs;
    demoStatus.value = ds;
  } finally {
    loading.value = false;
  }
}

async function importDemo(): Promise<void> {
  demoLoading.value = true;
  try {
    demoStatus.value = await api('/admin/api/demo-dataset/import', { method: 'POST', body: '{}' });
    ElMessage.success('演示数据已导入');
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    demoLoading.value = false;
  }
}

async function clearDemo(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '只会清理中枢内置演示对象和演示任务记录，不会删除你自己新建的路由、工具源、接入方或真实任务。',
      '清理演示数据',
      { type: 'warning', confirmButtonText: '清理', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  demoCleanupLoading.value = true;
  try {
    demoStatus.value = await api('/admin/api/demo-dataset', { method: 'DELETE' });
    ElMessage.success('演示数据已清理');
    window.dispatchEvent(new CustomEvent('bailing-demo-dataset-cleared'));
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    demoCleanupLoading.value = false;
  }
}

async function runSmoke(): Promise<void> {
  smokeLoading.value = true;
  try {
    smoke.value = await api<SmokeReport>('/admin/api/smoke', { method: 'POST', body: JSON.stringify({}) });
    if (smoke.value.fail) ElMessage.warning('Smoke 发现失败项，请查看明细');
    else ElMessage.success('Smoke 通过');
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    smokeLoading.value = false;
  }
}

const steps = computed(() => {
  const hasDemoTarget = targets.value.some((t) => t.name === 'demo-agent');
  const hasDemoProvider = providers.value.some((p) => p.name === 'demo-business');
  const smokeStatus: StepStatus = !smoke.value ? 'idle' : smoke.value.fail ? 'fail' : 'pass';
  return [
    {
      index: 1,
      key: 'credentials',
      title: '模型凭证',
      path: '/credentials',
      doc: '/docs/api',
      status: credentials.value.length ? 'pass' : hasDemoTarget ? 'warn' : 'idle',
      detail: credentials.value.length ? '已有模型凭证，生产模型可用。' : hasDemoTarget ? '演示数据使用确定性 demo-agent，可先不配置外部模型；生产场景需要补充。' : '真实 AI 场景需要先配置模型凭证。',
    },
    {
      index: 2,
      key: 'targets',
      title: '调度目标',
      path: '/targets',
      doc: '/docs#routes',
      status: targets.value.length ? 'pass' : 'idle',
      detail: targets.value.length ? `已有 ${targets.value.length} 个目标，路由可以选择执行边界。` : '还没有调度目标，任务无法被中枢内适配器或执行器认领。',
    },
    {
      index: 3,
      key: 'tools',
      title: '工具源',
      path: '/tools',
      doc: '/docs/tools',
      status: providers.value.length ? 'pass' : 'idle',
      detail: providers.value.length ? `已有 ${providers.value.length} 个工具源，业务接口可进入工具治理。` : '还没有工具源，AI 暂时不能调用业务系统接口。',
    },
    {
      index: 4,
      key: 'clients',
      title: '接入方',
      path: '/clients',
      doc: '/docs/api',
      status: clients.value.length ? 'pass' : 'idle',
      detail: clients.value.length ? `已有 ${clients.value.length} 个接入方，可带 token 调用 /run。` : '还没有接入方，业务系统无法主动触发中枢任务。',
    },
    {
      index: 5,
      key: 'routes',
      title: '触发路由',
      path: '/routes',
      doc: '/docs#routes',
      status: routes.value.length ? 'pass' : 'idle',
      detail: routes.value.length ? `已有 ${routes.value.length} 条触发路由，场景装配已开始成型。` : '还没有触发路由，中枢不知道请求应该派给哪个目标。',
    },
    {
      index: 6,
      key: 'smoke',
      title: 'Smoke 验证',
      path: '/diagnostics',
      doc: '/docs/operations',
      status: smokeStatus,
      detail: smoke.value ? (smoke.value.fail ? 'Smoke 有失败项，建议先处理再对外接入。' : 'Smoke 已通过，基础调用链路可用。') : (hasDemoProvider ? '建议运行 smoke，确认 demo 或当前配置可完成建单与 trace。' : '完成上面配置后运行 smoke，锁定端到端链路。'),
    },
  ] as Array<{ index: number; key: string; title: string; path: string; doc: string; status: StepStatus; detail: string }>;
});
const passedSteps = computed(() => steps.value.filter((s) => s.status === 'pass' || s.status === 'warn').length);
const nextStep = computed(() => steps.value.find((s) => s.status !== 'pass' && s.status !== 'warn' && s.status !== 'skip') ?? null);

function tagType(status: StepStatus): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'pass') return 'success';
  if (status === 'warn') return 'warning';
  if (status === 'fail') return 'danger';
  return 'info';
}
function statusLabel(status: StepStatus): string {
  if (status === 'pass') return '完成';
  if (status === 'warn') return '可跳过';
  if (status === 'fail') return '失败';
  if (status === 'skip') return '跳过';
  return '待配置';
}
function openDocs(): void { openDoc('/docs'); }
function openDocPath(path: string): void { openDoc(path); }

function onDemoImported(): void { void load(); }

onMounted(() => {
  void load();
  window.addEventListener('bailing-demo-dataset-imported', onDemoImported);
});
onUnmounted(() => window.removeEventListener('bailing-demo-dataset-imported', onDemoImported));
</script>

<style scoped>
.setup { display: flex; flex-direction: column; gap: 16px; }
.panel { border-radius: 10px; }
.head { display: flex; align-items: center; gap: 10px; }
.headActions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
.summary > div { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 12px; background: var(--el-fill-color-blank); display: flex; flex-direction: column; gap: 6px; }
.summary b { font-size: 20px; }
.nextPanel { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 14px; margin-bottom: 16px; background: var(--el-fill-color-light); display: flex; align-items: center; gap: 16px; }
.nextMain { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1; }
.nextMain b { font-size: 18px; }
.nextMain p { margin: 0; color: var(--el-text-color-regular); line-height: 1.6; }
.nextActions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.step { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 14px; min-height: 150px; display: flex; flex-direction: column; gap: 10px; background: var(--el-fill-color-blank); }
.step.pass { border-color: rgba(82, 196, 26, 0.45); }
.step.warn { border-color: rgba(230, 162, 60, 0.45); }
.step.fail { border-color: rgba(245, 108, 108, 0.55); }
.stepTop { display: flex; align-items: center; gap: 8px; }
.stepTop .num { width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); font-size: 12px; font-weight: 700; }
.step p { margin: 0; color: var(--el-text-color-regular); line-height: 1.65; flex: 1; }
.actions { display: flex; align-items: center; gap: 6px; }
.guideGrid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; margin-top: 4px; }
.guideGrid.single { grid-template-columns: minmax(0, 1fr); }
.smoke { display: flex; flex-direction: column; gap: 12px; }
.smokeMeta { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--el-text-color-secondary); }
.mono { font-family: var(--bz-mono); }
code { font-family: var(--bz-mono); font-size: 12px; background: var(--el-fill-color-light); padding: 1px 4px; border-radius: 4px; }
@media (max-width: 1100px) {
  .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .guideGrid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 760px) {
  .summary, .steps { grid-template-columns: 1fr; }
  .nextPanel { align-items: flex-start; flex-direction: column; }
  .nextActions { justify-content: flex-start; }
}
</style>
