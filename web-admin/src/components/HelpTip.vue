<template>
  <el-popover placement="top-start" :width="400" trigger="click">
    <template #reference>
      <span
        class="help-q-wrap"
        :title="'点击查看：' + title"
        :aria-label="'点击查看：' + title"
        role="button"
        tabindex="0"
        @pointerdown.stop.prevent
        @mousedown.stop.prevent
        @click.stop.prevent
        @keydown.enter.stop.prevent
        @keydown.space.stop.prevent
      >
        <el-icon class="help-q"><QuestionFilled /></el-icon>
      </span>
    </template>
    <div class="ht-title">{{ title }}</div>
    <div class="ht-body"><slot /></div>
  </el-popover>
</template>

<script setup lang="ts">
// 表单字段帮助（统一规约）：复杂/关键字段的标题保持简短，详细说明进问号弹层——
// 标题括号塞不下长说明，也保证全后台帮助形态一致。用法：
//   <template #label>字段名 <HelpTip title="字段名是什么"><p>说明…</p></HelpTip></template>
import { QuestionFilled } from '@element-plus/icons-vue';
defineProps<{ title: string }>();
</script>

<style scoped>
.help-q-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 4px;
  color: var(--el-text-color-placeholder);
  cursor: pointer;
  line-height: 1;
  vertical-align: -2px;
}
.help-q { font-size: 14px; }
.help-q-wrap:hover { color: var(--el-color-primary); }
.ht-title { font-weight: 600; font-size: 13px; margin-bottom: 6px; color: var(--el-text-color-primary); }
.ht-body { font-size: 12px; line-height: 1.75; color: var(--el-text-color-regular); }
.ht-body :deep(p) { margin: 0 0 6px; }
.ht-body :deep(p:last-child) { margin-bottom: 0; }
.ht-body :deep(code) { font-family: var(--bz-mono); font-size: 11px; background: var(--el-fill-color-light); padding: 1px 4px; border-radius: 4px; }
.ht-body :deep(b) { color: var(--el-text-color-primary); }
</style>
