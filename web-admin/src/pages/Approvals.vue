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
    <el-table :data="list" row-key="id" :expand-row-keys="expandedId === null ? [] : [expandedId]" @expand-change="expandApproval" v-loading="loading" :empty-text="error ? '审批列表读取失败' : '正在读取审批列表'">
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="intent">
            <template v-if="row.details_available && !completeDetail(row)">
              <div class="snapshot-heading"><span>参数预览 · {{ row.args_bytes }} 字节</span><HelpTip title="完整审批快照"><p>列表只保留有界预览。展开时按需读取原参数和审批意图；完整快照读取成功前不能批准。列表自动刷新不会再次下载全文。</p></HelpTip></div>
              <el-alert v-if="detailState?.error" :title="detailState.error" type="error" :closable="false" show-icon />
              <pre class="block preview">{{ row.args_preview || '无参数预览' }}</pre>
              <el-button size="small" :loading="detailState?.loading" @click="loadDetail(row)">{{ detailState?.error ? '重试读取完整快照' : '读取完整快照' }}</el-button>
            </template>
            <template v-else>
            <div class="td-sec">完整参数快照<span v-if="row.args_bytes"> · {{ row.args_bytes }} 字节</span></div>
            <pre v-if="typeof (completeDetail(row) || row).args_json === 'string'" class="block">{{ pretty((completeDetail(row) || row).args_json) }}</pre>
            <p v-else class="muted">该历史记录未保存独立参数快照，请核对下方审批意图。</p>
            <template v-if="(completeDetail(row) || row).intent">
              <div class="td-sec">审批意图完整快照</div>
              <pre class="block">{{ JSON.stringify((completeDetail(row) || row).intent, null, 2) }}</pre>
            </template>
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
            <span v-if="row.details_available && !completeDetail(row)" class="muted">展开读取完整快照后批准</span>
            <el-popconfirm :title="row.continuation_mode === 'manual' ? '批准冻结的调用快照？批准后须由原客户端使用同一调用标识继续，中枢不会自动重跑。' : '批准冻结的调用快照？决策保存后按原任务续办方式处理，批准不代表业务执行成功。'" width="320" @confirm="decide(row.id, 'approve')">
              <template #reference><el-button link type="success" :disabled="Boolean(error) || loading || deciding !== null || Boolean(row.details_available && !completeDetail(row))" :loading="deciding === row.id">兜底批准</el-button></template>
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
const expandedId = ref<number | null>(null);
const detailState = ref<{ key: string; loading: boolean; error: string; data?: any } | null>(null);
let detailGeneration = 0;

function detailKey(row: any): string { return `${row.id}:${row.args_hash ?? ''}:${row.created_at ?? ''}`; }
function completeDetail(row: any): any | null {
  return detailState.value?.key === detailKey(row) ? detailState.value.data ?? null : null;
}
function clearDetail(): void { detailGeneration++; detailState.value = null; }
function expandApproval(row: any, expandedRows: any[]): void {
  const opened = expandedRows.some(item => item.id === row.id);
  if (!opened) {
    if (expandedId.value === row.id) { expandedId.value = null; clearDetail(); }
    return;
  }
  if (expandedId.value === row.id) return;
  expandedId.value = row.id; clearDetail();
  if (row.details_available) void loadDetail(row);
}
async function loadDetail(row: any): Promise<void> {
  if (!me.can('runs:read') || expandedId.value !== row.id || detailState.value?.loading) return;
  const current = ++detailGeneration, key = detailKey(row);
  detailState.value = { key, loading: true, error: '' };
  const owns = () => current === detailGeneration && expandedId.value === row.id
    && list.value.some(item => detailKey(item) === key);
  try {
    const data = await api(`/admin/api/tool-approvals/${row.id}/details`);
    if (!owns()) return;
    if (detailKey(data) !== key || data.details_available || data.args_truncated
      || (row.args_bytes > 0 && typeof data.args_json !== 'string')) throw new Error('snapshot_mismatch');
    detailState.value = { key, loading: false, error: '', data };
  } catch {
    if (owns()) detailState.value = { key, loading: false, error: '完整快照读取失败，当前仅显示预览；请重试。' };
  }
}

async function load(): Promise<void> {
  const current = ++generation, requestedStatus = status.value;
  if (loadedStatus !== requestedStatus) { list.value = []; expandedId.value = null; clearDetail(); }
  loading.value = true; error.value = '';
  try {
    const rows = await api('/admin/api/tool-approvals?status=' + requestedStatus);
    if (current !== generation) return;
    list.value = rows; loadedStatus = requestedStatus; loadedAt.value = new Date().toISOString();
    const expanded = rows.find((item: any) => item.id === expandedId.value);
    if (!expanded) { expandedId.value = null; clearDetail(); }
    else if (detailState.value && detailState.value.key !== detailKey(expanded)) clearDetail();
  } catch {
    if (current === generation) error.value = '暂时无法读取审批列表，请刷新重试。';
  } finally { if (current === generation) loading.value = false; }
}
async function decide(id: number, action: 'approve' | 'deny'): Promise<void> {
  if (!me.can('runs:write') || error.value || loading.value || deciding.value !== null) return;
  const row = list.value.find(item => item.id === id);
  if (!row || (action === 'approve' && row.details_available && !completeDetail(row))) return;
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
onUnmounted(() => { window.clearInterval(timer); generation++; clearDetail(); });
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
.snapshot-heading { display: flex; align-items: center; gap: 6px; margin: 8px 0 4px; color: var(--el-text-color-secondary); font-size: 12px; }
.block { background: var(--el-fill-color-lighter); border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 8px; overflow: auto; max-height: 260px; font-family: var(--bz-mono); font-size: 12px; }
</style>
