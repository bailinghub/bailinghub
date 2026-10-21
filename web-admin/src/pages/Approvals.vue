<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>审批意图</b> <HelpTip title="审批意图是什么">
          <p>高风险或命中参数级确认规则的工具调用会先冻结成审批意图。批准只授权这次调用快照，不代表业务已经执行成功。</p>
          <p>中枢任务由中枢续办；本地智能体工具调用须回到原客户端，使用同一调用标识继续。</p>
          <p>如果路由配置了业务侧审批承接，这里仍可追溯中枢侧意图与最终决策；实际审批人和审批页面由业务系统决定。</p>
        </HelpTip>
        <el-button style="margin-left: auto" @click="openDocs">开发文档</el-button>
        <el-button :loading="loading" @click="load">刷新</el-button>
        <el-radio-group v-model="status" size="small" @change="load">
          <el-radio-button value="pending">待审批</el-radio-button>
          <el-radio-button value="all">全部</el-radio-button>
        </el-radio-group>
      </div>
    </template>
    <el-alert v-if="error" :title="error" :description="list.length ? `当前保留上次成功读取的旧快照（${fmtTime(loadedAt, true)}），刷新成功前不能裁决。` : '尚未取得审批列表，不能据此判断没有待审批项。'" type="error" :closable="false" show-icon />
    <el-alert v-if="decisionNotice" :title="decisionNotice" :type="decisionNoticeType" :closable="true" show-icon @close="decisionNotice = ''" />
    <el-empty v-if="!list.length && !loading && !error" :description="status === 'pending' ? '没有待审批的调用' : '还没有审批记录'" />
    <div v-else class="approval-list">
    <el-table :data="list" row-key="id" v-loading="loading" :empty-text="error ? '审批列表读取失败' : '正在读取审批列表'">
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
      <el-table-column label="审批意图" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="intent-main">
            <span class="muted">#{{ row.id }} · {{ fmtTime(row.created_at) }}</span>
            <b>{{ row.summary || row.reason || row.tool }}</b>
            <span class="muted ellipsis">{{ row.reason || policyLabel(row.policy, row.risk) }}</span>
            <code>{{ row.provider }} · {{ row.tool }}</code>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="调用上下文" min-width="190" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="intent-stack">
            <code>{{ row.method }} {{ row.path }}</code>
            <span class="muted mono">{{ row.scope }}</span>
            <span class="muted">主体 {{ row.on_behalf_of || '无主体' }}</span>
            <el-button link type="primary" size="small" @click="openJob(row.job_id)">看任务</el-button>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="治理规则" width="100">
        <template #default="{ row }">
          <div class="intent-stack">
            <el-tag size="small" effect="plain" :type="row.risk === 'high' ? 'danger' : 'warning'">{{ riskLabel(row.risk) }}</el-tag>
            <span class="muted">{{ policyLabel(row.policy, row.risk) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="决策与续办" min-width="220">
        <template #default="{ row }">
          <div class="intent-stack">
            <el-tag size="small" :type="statusType(row)" effect="plain">{{ statusLabel(row) }}</el-tag>
            <span v-if="row.decided_by" class="muted ellipsis">{{ row.decided_by }} · {{ fmtTime(row.decided_at) }}</span>
            <span class="muted">{{ approvalProgress(row) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column v-if="me.can('runs:write')" width="140" align="right">
        <template #default="{ row }">
          <template v-if="row.status === 'pending'">
            <el-popconfirm :title="row.continuation_mode === 'manual' ? '批准冻结的调用快照？批准后须由原客户端使用同一调用标识继续，中枢不会自动重跑。' : '批准冻结的调用快照？决策保存后按原任务续办方式处理，批准不代表业务执行成功。'" width="320" @confirm="decide(row.id, 'approve')">
              <template #reference><el-button link type="success" :disabled="Boolean(error) || loading || deciding !== null" :loading="deciding === row.id">兜底批准</el-button></template>
            </el-popconfirm>
            <el-popconfirm title="拒绝该意图？任务保持原结论，不会重跑。" width="260" @confirm="decide(row.id, 'deny')">
              <template #reference><el-button link type="danger" :disabled="Boolean(error) || loading || deciding !== null">兜底拒绝</el-button></template>
            </el-popconfirm>
          </template>
        </template>
      </el-table-column>
    </el-table>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../request';
import { openDoc } from '../docs';
import { fmtTime } from '../util';
import HelpTip from '../components/HelpTip.vue';
import { useMe } from '../store';
import { approvalFeedback, approvalProgress } from '../runtime-feedback';

const router = useRouter();
const list = ref<any[]>([]);
const status = ref('pending');
const me = useMe();
const loading = ref(false), error = ref(''), loadedAt = ref('');
const deciding = ref<number | null>(null), decisionNotice = ref('');
const decisionNoticeType = ref<'success' | 'warning'>('success');
let generation = 0, loadedStatus = '';
let timer = 0;

async function load(): Promise<void> {
  const current = ++generation, requestedStatus = status.value;
  if (loadedStatus !== requestedStatus) list.value = [];
  loading.value = true; error.value = '';
  try {
    const rows = await api('/admin/api/tool-approvals?status=' + requestedStatus);
    if (current !== generation) return;
    list.value = rows; loadedStatus = requestedStatus; loadedAt.value = new Date().toISOString();
  } catch {
    if (current === generation) error.value = '暂时无法读取审批列表，请刷新重试。';
  } finally { if (current === generation) loading.value = false; }
}
async function decide(id: number, action: 'approve' | 'deny'): Promise<void> {
  if (!me.can('runs:write') || error.value || loading.value || deciding.value !== null) return;
  deciding.value = id; decisionNotice.value = '';
  try {
    const r = await api<{ rerun: boolean; continuation_mode?: string; continuation_pending?: boolean }>(`/admin/api/tool-approvals/${id}/${action}`, { method: 'POST' });
    decisionNotice.value = approvalFeedback(r, action);
    decisionNoticeType.value = r.continuation_pending ? 'warning' : 'success';
  } catch (e) {
    decisionNotice.value = `本次操作未得到完整确认：${(e as Error).message}。正在核对原审批单；请以刷新后的决策状态为准。`;
    decisionNoticeType.value = 'warning';
  } finally { await load(); deciding.value = null; }
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
  if (row.status === 'approved') return row.used_at ? '已批准 · 批准已使用' : '已批准';
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
.head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.approval-list { overflow-x: auto; }
.approval-list .el-table { min-width: 920px; }
.el-alert { margin-bottom: 12px; }
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
