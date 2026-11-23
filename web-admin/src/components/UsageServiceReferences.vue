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
          title="删除后，所有套餐和客户端将移除此模型"
          description="移除最后一个模型后，对应套餐将没有可用模型。账户额度、模型凭证与历史用量会保留。"
          type="warning"
          :closable="false"
        />
        <section>
          <h3>
            将更新的套餐 <small>{{ report.plans.total }} 个</small>
            <UsageHelp title="模型服务的影响范围"><p>如只需从单个套餐移除模型，请单独编辑该套餐。已关联账户继续持有原套餐，已发出的请求仍按原模型核对和计量。</p></UsageHelp>
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
        <p><b>{{ report.accounts.total }} 个账户关联上述套餐</b></p>
        <p><b>{{ report.requests.total }} 笔原请求记录保留</b></p>
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
import UsageHelp from "./UsageHelp.vue";
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
@media (max-width: 600px) {
  .reference-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
}
</style>
