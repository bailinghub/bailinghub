<template>
  <el-drawer
    :model-value="modelValue"
    :title="`删除模型服务：${label}`"
    size="min(560px, 100vw)"
    class="usage-references-drawer"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-loading="loading" class="references">
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <template v-if="report">
        <el-alert
          title="删除后，该模型会从所有套餐及客户端可选列表中移除。"
          type="warning"
          :closable="false"
        />
        <p class="explanation">
          账户额度与历史用量保留。删至零个模型时，用户会看到“暂无可用模型”。
        </p>
        <section>
          <h3>
            将更新的套餐 <small>{{ report.plans.total }} 个</small>
          </h3>
          <p v-if="!report.plans.total" class="muted">
            当前没有套餐包含此模型。
          </p>
          <div
            v-for="plan in report.plans.items"
            :key="plan.id"
            class="reference-row"
          >
            <div>
              <b>{{ plan.label }}</b
              ><code>{{ plan.id }}</code>
            </div>
            <el-button
              v-if="canEditPlans"
              link
              type="primary"
              :disabled="busy"
              @click="emit('plan', plan.id)"
              >查看套餐</el-button
            >
          </div>
          <p v-if="report.plans.truncated" class="muted">
            显示前 {{ report.plans.items.length }} 个；删除会从全部
            {{ report.plans.total }} 个套餐中移除。
          </p>
        </section>
        <p>
          <b>{{ report.accounts.total }} 个账户关联上述套餐</b><br /><span
            class="muted"
            >账户仍然持有原套餐，无需逐个调整或重新开通。</span
          >
        </p>
        <p>
          <b>{{ report.requests.total }} 笔原请求记录保留</b><br /><span
            class="muted"
            >已发出的请求按原模型核对结果和计量，不会切换到其他模型或重复执行。</span
          >
        </p>
        <p class="muted">
          模型凭证与历史用量仍保留。若只想从某个套餐移除模型，请直接编辑该套餐。
        </p>
      </template>
    </div>
    <template #footer
      ><div class="drawer-actions">
        <el-button @click="emit('update:modelValue', false)">取消</el-button>
        <el-button :loading="loading" :disabled="busy" @click="emit('refresh')"
          >刷新影响范围</el-button
        >
        <el-button
          type="danger"
          :loading="busy"
          :disabled="busy || loading || !!error || !report?.deletable"
          @click="emit('delete')"
          >确认删除模型服务</el-button
        >
      </div></template
    >
  </el-drawer>
</template>
<script setup lang="ts">
import type { ServiceReferenceReport } from "../usage-management";
defineProps<{
  modelValue: boolean;
  label: string;
  report: ServiceReferenceReport | null;
  loading: boolean;
  busy: boolean;
  error: string;
  canEditPlans: boolean;
}>();
const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "refresh"): void;
  (e: "delete"): void;
  (e: "plan", id: string): void;
}>();
</script>
<style scoped>
.drawer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.drawer-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.usage-references-drawer :deep(.el-drawer__footer) {
  border-top: 1px solid var(--el-border-color-light);
  padding: 16px 20px;
}
.references {
  display: grid;
  gap: 16px;
  min-height: 100px;
}
.references h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.references small {
  font-weight: 400;
  color: var(--el-text-color-secondary);
  margin-left: 8px;
}
.reference-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  padding: 12px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.reference-row > div {
  min-width: 0;
}
.reference-row code {
  display: block;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  overflow-wrap: anywhere;
  margin-top: 4px;
}
.references p {
  line-height: 1.65;
  margin: 4px 0;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.explanation {
  background: var(--el-fill-color-light);
  padding: 12px;
  border-radius: 8px;
}
@media (max-width: 600px) {
  .reference-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
}
</style>
