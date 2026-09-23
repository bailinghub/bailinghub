<template>
  <el-popover
    v-model:visible="open"
    placement="top-start"
    width="min(360px, calc(100vw - 40px))"
    trigger="click"
  >
    <template #reference
      ><button
        type="button"
        class="usage-help"
        :aria-label="title"
        :aria-expanded="open"
        @click.stop
        @keydown.esc.stop="open = false"
      >
        <el-icon class="usage-help-icon"><QuestionFilled /></el-icon>
      </button></template
    >
    <div class="help-title">{{ title }}</div>
    <div class="help-body"><slot /></div>
  </el-popover>
</template>
<script setup lang="ts">
import { ref } from "vue";
import { QuestionFilled } from "@element-plus/icons-vue";
defineProps<{ title: string }>();
const open = ref(false);
</script>
<style scoped>
.usage-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin-left: 4px;
  border: 0;
  color: var(--el-text-color-placeholder);
  background: transparent;
  line-height: 1;
  cursor: pointer;
  vertical-align: -2px;
}
.usage-help-icon {
  font-size: 14px;
}
.usage-help:hover,
.usage-help:focus-visible {
  color: var(--el-color-primary);
}
.usage-help:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 3px;
}
.help-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
  color: var(--el-text-color-primary);
}
.help-body {
  font-size: 12px;
  line-height: 1.75;
  color: var(--el-text-color-regular);
}
.help-body :deep(p) {
  margin: 0 0 6px;
}
.help-body :deep(p:last-child) {
  margin: 0;
}
</style>
