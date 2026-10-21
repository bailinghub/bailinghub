<template>
  <div class="list-location-bar">
    <el-input :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)" clearable :placeholder="placeholder || '搜索名称 / 标识'" :aria-label="placeholder || '搜索名称 / 标识'" maxlength="200" />
    <span class="location-count">{{ count }} / {{ total }} 项</span>
    <el-tag v-if="focus" type="info" effect="plain">定位：{{ focus }}{{ relatedFocus ? ` ↔ ${relatedFocus}` : '' }}</el-tag>
    <el-button v-if="modelValue || focus" link @click="$emit('clear')">清除筛选</el-button>
    <el-button v-if="returnTo" link type="primary" @click="router.push(returnTo)">返回{{ returnTo.startsWith('/diagnostics') ? '体检' : '来源页' }}</el-button>
  </div>
  <div v-if="focus && !count && total" class="location-missing" role="status">未找到对象「{{ focus }}」，它可能已删除或当前不可见。可清除筛选查看其他对象。</div>
</template>
<script setup lang="ts">
import { useRouter } from 'vue-router';
defineProps<{ modelValue: string; count: number; total: number; focus?: string; relatedFocus?: string; returnTo?: string; placeholder?: string }>();
defineEmits<{ 'update:modelValue': [value: string]; clear: [] }>();
const router = useRouter();
</script>
<style scoped>
.list-location-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.list-location-bar .el-input { width: 280px; max-width: 100%; }
.location-count, .location-missing { font-size: 12px; color: var(--el-text-color-secondary); }
.location-missing { margin: 0 0 12px; }
</style>
