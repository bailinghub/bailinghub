<template>
  <el-tooltip :content="raw ? '原始状态：' + raw : '原始记录缺少状态'" placement="top" :trigger="['hover', 'focus']">
    <el-tag class="jobStatusTag" :type="statusType(raw)" effect="plain" tabindex="0">{{ jobStatusLabel(raw) }}</el-tag>
  </el-tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { jobStatusLabel, statusType } from '../task-trace-presentation';

const props = defineProps<{ status?: string | null }>();
const raw = computed(() => typeof props.status === 'string' ? props.status.trim() : '');
</script>

<style scoped>
.jobStatusTag { cursor: help; }
.jobStatusTag:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
</style>
