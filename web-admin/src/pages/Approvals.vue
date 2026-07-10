<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>审批意图</b> <HelpTip title="审批意图是什么">
          <p>高风险或命中参数级确认规则的工具调用会先冻结成审批意图。中枢锁定调用快照，批准后任务自动重跑并只执行被批准的那次调用。</p>
          <p>如果路由配置了业务侧审批承接，这里仍可追溯中枢侧意图与最终决策；实际审批人和审批页面由业务系统决定。</p>
        </HelpTip>
        <el-button style="margin-left: auto" @click="openDocs">开发文档</el-button>
        <el-radio-group v-model="status" size="small" @change="load">
          <el-radio-button value="pending">待审批</el-radio-button>
          <el-radio-button value="all">全部</el-radio-button>
        </el-radio-group>
      </div>
    </template>
    <el-empty v-if="!list.length" :description="status === 'pending' ? '没有待审批的调用' : '还没有审批记录'" />
    <el-table v-else :data="list" row-key="id">
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="intent">
            <div class="td-sec">参数快照</div>
            <pre class="block">{{ pretty(row.args_json || '{}') }}</pre>
            <template v-if="row.intent">
              <div class="td-sec">审批意图完整快照</div>
              <pre class="block">{{ JSON.stringify(row.intent, null, 2) }}</pre>
            </template>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="审批意图" min-width="320" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="intent-main">
            <span class="muted">#{{ row.id }} · {{ fmtTime(row.created_at) }}</span>
            <b>{{ row.summary || row.reason || row.tool }}</b>
            <span class="muted ellipsis">{{ row.reason || policyLabel(row.policy, row.risk) }}</span>
            <code>{{ row.provider }} · {{ row.tool }}</code>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="调用上下文" min-width="260" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="intent-stack">
            <code>{{ row.method }} {{ row.path }}</code>
            <span class="muted mono">{{ row.scope }}</span>
            <span class="muted">主体 {{ row.on_behalf_of || '无主体' }}</span>
            <el-button link type="primary" size="small" @click="openJob(row.job_id)">看任务</el-button>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="治理规则" width="150">
        <template #default="{ row }">
          <div class="intent-stack">
            <el-tag size="small" effect="plain" :type="row.risk === 'high' ? 'danger' : 'warning'">{{ riskLabel(row.risk) }}</el-tag>
            <span class="muted">{{ policyLabel(row.policy, row.risk) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="决策状态" width="170">
        <template #default="{ row }">
          <div class="intent-stack">
            <el-tag size="small" :type="statusType(row)" effect="plain">{{ statusLabel(row) }}</el-tag>
            <span v-if="row.decided_by" class="muted ellipsis">{{ row.decided_by }} · {{ fmtTime(row.decided_at) }}</span>
            <span v-else class="muted">等待业务侧或控制台兜底决策</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column width="178" align="right">
        <template #default="{ row }">
          <template v-if="row.status === 'pending'">
            <el-popconfirm title="批准该意图？任务将自动重跑并执行这次已冻结的调用快照。" width="260" @confirm="decide(row.id, 'approve')">
              <template #reference><el-button link type="success">兜底批准</el-button></template>
            </el-popconfirm>
            <el-popconfirm title="拒绝该意图？任务保持原结论，不会重跑。" width="260" @confirm="decide(row.id, 'deny')">
              <template #reference><el-button link type="danger">兜底拒绝</el-button></template>
            </el-popconfirm>
          </template>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus/es/components/message/index';
import { api } from '../request';
import { openDoc } from '../docs';
import { fmtTime } from '../util';
import HelpTip from '../components/HelpTip.vue';

const router = useRouter();
const list = ref<any[]>([]);
const status = ref('pending');
let timer = 0;

async function load(): Promise<void> {
  list.value = await api('/admin/api/tool-approvals?status=' + status.value);
}
async function decide(id: number, action: 'approve' | 'deny'): Promise<void> {
  try {
    const r = await api<{ rerun: boolean }>(`/admin/api/tool-approvals/${id}/${action}`, { method: 'POST' });
    ElMessage.success(action === 'approve' ? (r.rerun ? '已批准，任务已自动重跑' : '已批准（任务在途，运行中会执行该调用）') : '已拒绝');
    await load();
  } catch (e) { ElMessage.error((e as Error).message); }
}
function openJob(jobId: string): void {
  void router.push('/runs?job=' + jobId);
}
function openDocs(): void {
  openDoc('/docs/approvals');
}
function policyLabel(policy?: string, risk?: string): string {
  if (policy === 'risk_high') return '高风险';
  if (policy === 'confirm_required') return '强制确认';
  if (policy === 'confirm_when') return '条件确认';
  return risk === 'high' ? '高风险' : '需确认';
}
function riskLabel(risk?: string): string {
  if (risk === 'high') return '高风险';
  if (risk === 'medium') return '中风险';
  return risk || '需确认';
}
function statusLabel(row: any): string {
  if (row.status === 'pending') return '待决策';
  if (row.status === 'approved') return row.used_at ? '已批准 · 已执行' : '已批准 · 待执行';
  return '已拒绝';
}
function statusType(row: any): 'warning' | 'success' | 'info' {
  if (row.status === 'pending') return 'warning';
  if (row.status === 'approved') return 'success';
  return 'info';
}
function pretty(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}
onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 30_000); // 审批是时效操作，轻刷新
});
onUnmounted(() => window.clearInterval(timer));
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.intent-main,
.intent-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  line-height: 1.35;
}
.intent-main b {
  max-width: 100%;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.intent-main code,
.intent-stack code {
  max-width: 100%;
  overflow: hidden;
  color: var(--el-text-color-secondary);
  font-family: var(--bz-mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.intent { padding: 4px 18px 10px 46px; }
.td-sec { margin: 8px 0 4px; color: var(--el-text-color-secondary); font-size: 12px; }
.block { background: var(--el-fill-color-lighter); border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 8px; overflow: auto; max-height: 260px; font-family: var(--bz-mono); font-size: 12px; }
</style>
