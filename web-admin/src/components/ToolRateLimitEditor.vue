<template>
  <div class="limit-editor">
    <el-select :model-value="modelValue.mode" style="width: 190px" @update:model-value="setMode">
      <el-option label="继承业务声明" value="inherit" />
      <el-option label="自定义中枢限额" value="custom" />
      <el-option label="关闭中枢单工具限额" value="disabled" />
    </el-select>
    <template v-if="modelValue.mode === 'custom'">
      <el-input-number :model-value="modelValue.count" :min="1" :max="1000000" :precision="0" @update:model-value="setCount" />
      <span>次 /</span>
      <el-select :model-value="modelValue.window" style="width: 92px" @update:model-value="setWindow">
        <el-option label="秒" value="1s" /><el-option label="分钟" value="1m" />
        <el-option label="小时" value="1h" /><el-option label="天" value="1d" />
      </el-select>
    </template>
  </div>
</template>
<script setup lang="ts">
type Policy = { mode: 'inherit' | 'custom' | 'disabled'; count?: number; window?: string };
const props = defineProps<{ modelValue: Policy }>();
const emit = defineEmits<{ 'update:modelValue': [value: Policy] }>();
function setMode(mode: Policy['mode']) { emit('update:modelValue', mode === 'custom' ? { mode, count: 120, window: '1h' } : { mode }); }
function setCount(count: number | undefined) { emit('update:modelValue', { ...props.modelValue, count }); }
function setWindow(window: string) { emit('update:modelValue', { ...props.modelValue, window }); }
</script>
<style scoped>
.limit-editor { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
