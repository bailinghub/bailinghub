<template>
  <el-card shadow="never">
    <template #header>
      <div class="head">
        <div>
          <b>成本观测</b>
          <HelpTip title="成本观测看什么">
            <p>这里按任务回报的 <code>usage</code> 聚合模型成本和 token，用来判断最近一段时间是否有异常消耗。</p>
            <p>本页只读，不拦截调用。真正的硬限在「接入方」和「触发路由」的成本预算闸里配置。</p>
            <p>执行器、业务工具或未回报 <code>usage</code> 的目标不会产生 <code>cost_usd</code>，这属于正常情况。</p>
          </HelpTip>
        </div>
        <div class="actions">
          <el-select v-model="days" size="small" style="width: 110px" @change="load">
            <el-option :value="7" label="近 7 天" />
            <el-option :value="30" label="近 30 天" />
            <el-option :value="90" label="近 90 天" />
          </el-select>
          <el-button size="small" :loading="loading" @click="load">刷新</el-button>
        </div>
      </div>
    </template>

    <div v-loading="loading" class="cost-page">
      <section class="overview">
        <div class="metric primary">
          <span>总花费</span>
          <b>{{ usd(total.cost_usd) }}</b>
          <em>{{ data?.days ?? days }} 天窗口</em>
        </div>
        <div class="metric">
          <span>任务数</span>
          <b>{{ int(total.jobs) }}</b>
          <em>{{ total.jobs ? `单任务 ${usd(costPerJob)}` : '暂无任务' }}</em>
        </div>
        <div class="metric">
          <span>Token</span>
          <b>{{ int(total.tokens) }}</b>
          <em>{{ total.tokens ? `单任务 ${int(tokensPerJob)}` : '未记录 token' }}</em>
        </div>
        <div class="metric">
          <span>日均花费</span>
          <b>{{ usd(dailyAvg) }}</b>
          <em>{{ hasCost ? `最高日 ${usd(maxDailyCost)}` : '无成本峰值' }}</em>
        </div>
      </section>

      <section class="notice" :class="{ empty: !hasCost }">
        <div>
          <b>{{ headline }}</b>
          <p>{{ headlineDesc }}</p>
        </div>
        <div class="notice-actions">
          <el-button size="small" @click="go('/clients')">接入方预算</el-button>
          <el-button size="small" @click="go('/routes')">路由预算</el-button>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <b>按天趋势</b>
            <span>用来判断是否有突增、持续增长或某天集中消耗。</span>
          </div>
        </div>
        <el-empty v-if="!dailyRows.length" description="该窗口内没有任务记录" />
        <div v-else class="trend">
          <div v-for="row in dailyRows" :key="row.day" class="day-row">
            <span class="mono day">{{ row.day }}</span>
            <div class="bar-track">
              <div class="bar" :style="{ width: barWidth(row.cost_usd) }" />
            </div>
            <span class="mono cost">{{ usd(row.cost_usd) }}</span>
            <span class="muted jobs">{{ int(row.jobs) }} 任务</span>
          </div>
        </div>
      </section>

      <section class="breakdown">
        <div class="section panel">
          <div class="section-head">
            <div>
              <b>调度目标消耗</b>
              <span>定位是哪个模型或执行目标产生费用。</span>
            </div>
          </div>
          <el-empty v-if="!targetRows.length" description="还没有目标成本数据" />
          <el-table v-else :data="targetRows" size="small" empty-text="无数据">
            <el-table-column prop="target" label="调度目标" min-width="150" show-overflow-tooltip>
              <template #default="{ row }"><code>{{ row.target }}</code></template>
            </el-table-column>
            <el-table-column label="占比" width="110">
              <template #default="{ row }">
                <div class="share"><span :style="{ width: shareWidth(row.cost_usd) }" /></div>
              </template>
            </el-table-column>
            <el-table-column prop="jobs" label="任务" width="76" align="right">
              <template #default="{ row }">{{ int(row.jobs) }}</template>
            </el-table-column>
            <el-table-column label="花费" width="104" align="right">
              <template #default="{ row }">{{ usd(row.cost_usd) }}</template>
            </el-table-column>
          </el-table>
        </div>

        <div class="section panel">
          <div class="section-head">
            <div>
              <b>触发路由消耗</b>
              <span>定位是哪个业务场景产生费用。</span>
            </div>
          </div>
          <el-empty v-if="!routeRows.length" description="还没有路由成本数据" />
          <el-table v-else :data="routeRows" size="small" empty-text="无数据">
            <el-table-column prop="route" label="触发路由" min-width="150" show-overflow-tooltip />
            <el-table-column label="占比" width="110">
              <template #default="{ row }">
                <div class="share"><span :style="{ width: shareWidth(row.cost_usd) }" /></div>
              </template>
            </el-table-column>
            <el-table-column prop="jobs" label="任务" width="76" align="right">
              <template #default="{ row }">{{ int(row.jobs) }}</template>
            </el-table-column>
            <el-table-column label="花费" width="104" align="right">
              <template #default="{ row }">{{ usd(row.cost_usd) }}</template>
            </el-table-column>
          </el-table>
        </div>
      </section>

      <section class="section guide">
        <div>
          <b>成本治理边界</b>
          <p>观测页负责看趋势和归因；预算闸负责拦截新任务；模型侧账单仍以模型服务商账单为准。</p>
        </div>
        <div class="guide-grid">
          <div><span>接入方预算</span><p>限制某个业务系统整体消耗，适合按调用方控成本。</p></div>
          <div><span>路由预算</span><p>限制某个 AI 场景消耗，适合按业务场景控成本。</p></div>
          <div><span>未记录 usage</span><p>执行器或目标未上报 usage 时，只能统计任务数，不会计入美元成本。</p></div>
        </div>
      </section>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../request';
import HelpTip from '../components/HelpTip.vue';

interface CostData {
  days: number;
  total: { jobs: number; cost_usd: number; tokens: number };
  by_day: Array<{ day: string; jobs: number; cost_usd: number }>;
  by_target: Array<{ target: string; jobs: number; cost_usd: number }>;
  by_route: Array<{ route: string; jobs: number; cost_usd: number }>;
}

const router = useRouter();
const data = ref<CostData | null>(null);
const days = ref(30);
const loading = ref(false);

const total = computed(() => data.value?.total ?? { jobs: 0, cost_usd: 0, tokens: 0 });
const hasCost = computed(() => total.value.cost_usd > 0);
const costPerJob = computed(() => total.value.jobs ? total.value.cost_usd / total.value.jobs : 0);
const tokensPerJob = computed(() => total.value.jobs ? total.value.tokens / total.value.jobs : 0);
const dailyAvg = computed(() => total.value.cost_usd / Math.max(1, data.value?.days ?? days.value));
const dailyRows = computed(() => [...(data.value?.by_day ?? [])].sort((a, b) => a.day.localeCompare(b.day)));
const targetRows = computed(() => (data.value?.by_target ?? []).slice(0, 10));
const routeRows = computed(() => (data.value?.by_route ?? []).slice(0, 10));
const maxDailyCost = computed(() => Math.max(0, ...dailyRows.value.map((r) => r.cost_usd)));
const topTarget = computed(() => targetRows.value[0]);
const topRoute = computed(() => routeRows.value[0]);
const headline = computed(() => {
  if (!total.value.jobs) return '该窗口内还没有任务';
  if (!hasCost.value) return '已有任务，但没有模型成本记录';
  return `主要消耗来自 ${topRoute.value?.route || topTarget.value?.target || '当前窗口任务'}`;
});
const headlineDesc = computed(() => {
  if (!total.value.jobs) return '业务系统触发路由后，这里会开始展示成本趋势和消耗归因。';
  if (!hasCost.value) return '通常是执行器目标、业务工具调用，或模型没有回报 usage。可以先用任务页查看运行链路是否正常。';
  const parts = [];
  if (topRoute.value) parts.push(`路由「${topRoute.value.route}」消耗 ${usd(topRoute.value.cost_usd)}`);
  if (topTarget.value) parts.push(`目标「${topTarget.value.target}」消耗 ${usd(topTarget.value.cost_usd)}`);
  return parts.join('，') + '。';
});

async function load(): Promise<void> {
  loading.value = true;
  try { data.value = await api<CostData>('/admin/api/cost?days=' + days.value); }
  finally { loading.value = false; }
}
function usd(v: number): string {
  const n = Number(v) || 0;
  if (n === 0) return '$0';
  return '$' + n.toFixed(n >= 1 ? 2 : 4);
}
function int(v: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Number(v) || 0);
}
function barWidth(v: number): string {
  if (!maxDailyCost.value) return '0%';
  return Math.max(4, Math.round((v / maxDailyCost.value) * 100)) + '%';
}
function shareWidth(v: number): string {
  if (!total.value.cost_usd) return '0%';
  return Math.max(3, Math.round((v / total.value.cost_usd) * 100)) + '%';
}
function go(path: string): void {
  void router.push(path);
}
onMounted(load);
</script>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.actions { display: inline-flex; align-items: center; gap: 8px; }
.cost-page { display: grid; gap: 18px; }
.overview {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border: 1px solid var(--el-border-color-lighter);
}
.metric {
  min-width: 0;
  padding: 18px 20px;
  border-right: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-lighter);
}
.metric:last-child { border-right: 0; }
.metric span,
.section-head span,
.guide p,
.guide-grid p { color: var(--el-text-color-secondary); }
.metric span { display: block; font-size: 12px; }
.metric b { display: block; margin-top: 8px; font-size: 25px; line-height: 1.15; font-family: var(--bz-mono); }
.metric.primary b { color: var(--el-color-primary); }
.metric em { display: block; margin-top: 6px; color: var(--el-text-color-placeholder); font-size: 12px; font-style: normal; }
.notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid rgba(63, 185, 80, .25);
  border-left: 3px solid var(--el-color-primary);
  background: rgba(63, 185, 80, .055);
}
.notice.empty {
  border-color: var(--el-border-color-lighter);
  border-left-color: var(--el-color-info);
  background: var(--el-fill-color-lighter);
}
.notice p { margin: 5px 0 0; color: var(--el-text-color-secondary); font-size: 13px; }
.notice-actions { display: inline-flex; gap: 8px; flex: none; }
.section {
  padding: 16px;
  border: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}
.section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.section-head b { display: block; margin-bottom: 3px; }
.section-head span { font-size: 12px; }
.trend { display: grid; gap: 8px; }
.day-row {
  display: grid;
  grid-template-columns: 94px minmax(120px, 1fr) 90px 74px;
  align-items: center;
  gap: 12px;
  min-height: 28px;
}
.day { color: var(--el-text-color-secondary); }
.cost { text-align: right; color: var(--el-text-color-primary); }
.jobs { text-align: right; font-size: 12px; }
.bar-track { height: 8px; background: var(--el-fill-color-light); }
.bar { height: 100%; background: linear-gradient(90deg, rgba(63, 185, 80, .42), var(--el-color-primary)); }
.breakdown { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.panel { min-width: 0; }
.share { height: 7px; background: var(--el-fill-color-light); }
.share span { display: block; height: 100%; background: var(--el-color-primary); }
.guide {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 18px;
}
.guide p { margin: 6px 0 0; font-size: 13px; }
.guide-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.guide-grid div { padding-left: 12px; border-left: 2px solid var(--el-border-color); }
.guide-grid span { font-weight: 650; }
.guide-grid p { margin-top: 5px; line-height: 1.6; }
.muted { color: var(--el-text-color-secondary); }
@media (max-width: 1100px) {
  .overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .metric:nth-child(2) { border-right: 0; }
  .metric:nth-child(-n + 2) { border-bottom: 1px solid var(--el-border-color-lighter); }
  .breakdown,
  .guide,
  .guide-grid { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
  .head,
  .notice { align-items: stretch; flex-direction: column; }
  .actions,
  .notice-actions { justify-content: flex-start; }
  .overview { grid-template-columns: 1fr; }
  .metric { border-right: 0; border-bottom: 1px solid var(--el-border-color-lighter); }
  .metric:last-child { border-bottom: 0; }
  .day-row { grid-template-columns: 88px 1fr; }
  .cost,
  .jobs { text-align: left; }
}
</style>
