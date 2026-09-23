<template>
  <el-drawer :model-value="modelValue" :title="`${report?.kind === 'account' ? '移除' : '删除'}：${label}`" size="min(560px, 100vw)"
    :close-on-click-modal="false" @update:model-value="emit('update:modelValue', $event)">
    <div v-loading="loading" class="deletion-content">
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-alert v-if="disabledReason" :title="disabledReason" type="info" :closable="false" />
      <template v-if="report">
        <el-alert :title="report.can_delete ? (report.kind === 'account' ? '当前可以移除' : '当前可以删除') : (report.kind === 'account' ? '当前不能直接移除' : '当前不能直接删除')"
          :type="report.can_delete ? 'warning' : 'info'" :closable="false" />
        <p>{{ report.effect }}</p>
        <ul v-if="report.blockers.length">
          <li v-for="item in report.blockers" :key="item.code">{{ item.message }} <span class="muted">（{{ item.count }} {{ item.code === 'PLAN_CURRENT_ACCOUNTS' ? '个账户' : '项' }}）</span></li>
        </ul>
        <p v-if="!report.can_delete" class="muted">{{ report.kind === 'plan' ? '请先为占用账户更换或停用其套餐，或等待到期。已换套餐、已到期、已停用的关联不影响删除；历史记录继续保留。' : report.kind === 'account' ? '请先停用账户，再刷新移除状态。历史套餐、凭证、请求和计量记录不会阻止移除；身份与历史会继续保留。' : '如需停止使用，请使用原页面的停用操作；历史关联仍会保留。' }}</p>
      </template>
    </div>
    <template #footer>
      <div class="deletion-actions">
        <el-button @click="emit('update:modelValue', false)">关闭</el-button>
        <el-button :disabled="busy" :loading="loading" @click="emit('refresh')">刷新占用</el-button>
        <el-button type="danger" :disabled="busy || loading || !!error || !!disabledReason || !report?.can_delete"
          @click="emit('delete')">{{ report?.kind === 'account' ? '确认移除' : '确认删除' }}</el-button>
      </div>
    </template>
  </el-drawer>
</template>
<script setup lang="ts">
import type { UsageDeletionReport } from '../usage-deletion';
defineProps<{
  modelValue: boolean; label: string; report: UsageDeletionReport | null;
  loading: boolean; busy: boolean; error: string; disabledReason?: string;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'refresh'): void;
  (e: 'delete'): void;
}>();
</script>
<style scoped>
.deletion-content { display: grid; gap: 16px; }
p, ul { margin: 0; line-height: 1.8; }
.muted { color: var(--el-text-color-secondary); }
.deletion-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
