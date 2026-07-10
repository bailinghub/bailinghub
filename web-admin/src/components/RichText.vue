<!-- 审计/详情用：把文本里的 ![alt](url) 图片渲染成可点开预览的缩略图，其余按纯文本（保留换行）。零 HTML 注入。 -->
<template>
  <div class="rich">
    <template v-for="(seg, i) in segs" :key="i">
      <el-image v-if="seg.t === 'img'" :src="seg.v" :preview-src-list="[seg.v]" :preview-teleported="true"
        fit="contain" class="rimg" :title="seg.alt" />
      <span v-else class="rtext">{{ seg.v }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ text?: string }>();
const segs = computed(() => {
  const out: Array<{ t: 'text' | 'img'; v: string; alt?: string }> = [];
  const s = String(props.text ?? '');
  const re = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    out.push({ t: 'img', v: m[2]!, alt: m[1] || '图片' });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  if (!out.length) out.push({ t: 'text', v: s });
  return out;
});
</script>

<style scoped>
.rich { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.65; }
.rtext { white-space: pre-wrap; }
.rimg { max-width: 240px; max-height: 240px; border-radius: 8px; border: 1px solid var(--el-border-color-lighter); display: block; margin: 6px 0; background: var(--el-fill-color-light); }
</style>
