<template>
  <div class="notification-panel" v-loading="loading">
    <p class="field-hint">查看已保存的通知与补发进度。重新发送只处理通知，原业务任务不会再次执行。</p>
    <div class="filters">
      <el-select v-model="kind" aria-label="通知类型" style="width:160px" @change="reset">
        <el-option v-for="item in kinds" :key="item.value" :value="item.value" :label="item.label" />
      </el-select>
      <el-select v-model="status" aria-label="通知状态" style="width:160px" @change="reset">
        <el-option value="" label="全部状态" />
        <el-option v-for="(label, value) in statusLabels" :key="value" :value="value" :label="label" />
      </el-select>
      <el-button :loading="loading" @click="load">刷新通知</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="warning" :closable="false" show-icon />
    <template v-else-if="data">
      <div class="totals">
        <span>等待补发 <b>{{ data.snapshot.counts.pending }}</b></span>
        <span>正在处理 <b>{{ data.snapshot.counts.processing }}</b></span>
        <span>处理失败 <b>{{ data.snapshot.counts.failed }}</b></span>
        <span>需核对 <b>{{ data.snapshot.counts.uncertain }}</b></span>
      </div>
      <el-table :data="data.items" size="small" empty-text="暂无此类通知" row-key="event_id">
        <el-table-column label="状态" width="120">
          <template #default="{ row }"><el-tag :type="row.status === 'uncertain' ? 'warning' : row.status === 'failed' ? 'danger' : row.status === 'completed' ? 'success' : 'info'">{{ statusLabels[row.status] }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="job_id" label="关联任务" min-width="200" show-overflow-tooltip />
        <el-table-column prop="event_id" label="通知编号" min-width="220" show-overflow-tooltip />
        <el-table-column prop="attempts" label="处理次数" width="90" />
        <el-table-column label="最近更新" width="160"><template #default="{ row }">{{ fmtTime(row.updated_at) }}</template></el-table-column>
        <el-table-column prop="last_error" label="处理说明代码" min-width="180" show-overflow-tooltip />
        <el-table-column v-if="me.can('runs:write')" label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'failed' || row.status === 'uncertain'" link type="primary" :loading="retrying === row.event_id" @click="retry(row)">
              {{ row.status === 'uncertain' ? '核对后重新发送' : '重新处理通知' }}
            </el-button>
            <span v-else>—</span>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination v-model:current-page="page" :page-size="20" :total="data.total" layout="total, prev, pager, next" @current-change="load" />
      <p class="field-hint">“通知已处理”包括交给通知执行器继续发送，不代表收件人已阅读。结果不明时，请先核对收件方；重新发送可能造成重复消息。</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import { api } from '../request';
import { useMe } from '../store';
import { fmtTime } from '../util';

interface Row { event_id: string; kind: string; job_id: string; status: string; attempts: number; updated_at: string; last_error: string | null }
interface Result { items: Row[]; total: number; snapshot: { counts: Record<string, number> } }
const me = useMe();
const kinds = [ { value: 'callback', label: '任务回调' }, { value: 'delivery', label: '结果送达' },
  { value: 'approval-notification', label: '审批提示' }, { value: 'delivery-dlq', label: '通知失败留存' } ];
const statusLabels: Record<string, string> = { pending: '等待补发', processing: '正在处理', completed: '通知已处理', skipped: '无需发送', failed: '处理失败', uncertain: '需核对' };
const kind = ref('callback'), status = ref(''), page = ref(1), loading = ref(false), retrying = ref(''), error = ref('');
const data = ref<Result | null>(null);
let generation = 0;
async function load(): Promise<void> {
  const current = ++generation;
  loading.value = true; error.value = '';
  const params = new URLSearchParams({ kind: kind.value, offset: String((page.value - 1) * 20) });
  if (status.value) params.set('status', status.value);
  try {
    const result = await api<Result>(`/admin/api/notification-outbox?${params}`);
    if (current === generation) data.value = result;
  } catch (failure) {
    if (current !== generation) return;
    data.value = null;
    error.value = (failure as Error).message === 'notification_durability_unavailable'
      ? '当前存储实现未提供这类通知的持久化能力。'
      : '暂时无法读取通知状态，请稍后重试。';
  } finally { if (current === generation) loading.value = false; }
}
function reset(): void { page.value = 1; void load(); }
async function retry(row: Row): Promise<void> {
  try {
    await ElMessageBox.confirm(row.status === 'uncertain'
      ? '这条通知可能已部分或全部送达。请先核对收件方，确认仍需重新发送；继续可能产生重复消息。'
      : '修复通知接收端后，可以重新处理这条通知。原业务任务不会再次执行。', '重新处理通知',
      { confirmButtonText: row.status === 'uncertain' ? '已核对，仍需发送' : '重新处理', cancelButtonText: '取消', type: 'warning' });
  } catch { return; }
  retrying.value = row.event_id;
  try {
    await api(`/admin/api/notification-outbox/${encodeURIComponent(row.event_id)}/retry`, {
      method: 'POST', body: JSON.stringify({ kind: row.kind, expected_status: row.status, allow_uncertain: row.status === 'uncertain' }),
    });
    ElMessage.success('已加入通知处理队列');
    await load();
  } catch { ElMessage.error('未能加入队列，通知状态可能已变化，请刷新核对。'); }
  finally { retrying.value = ''; }
}
defineExpose({ refresh: load });
onMounted(load);
</script>

<style scoped>
.filters, .totals { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin: 14px 0; }
.totals { color: var(--el-text-color-secondary); font-size: 13px; }
.totals b { margin-left: 5px; color: var(--el-text-color-primary); }
.el-pagination { margin-top: 16px; }
</style>
