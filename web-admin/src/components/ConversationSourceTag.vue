<template>
  <span class="sourceTag" :class="'source-' + source">
    <el-icon aria-hidden="true"><component :is="icons[source]" /></el-icon>{{ conversationSources[source] }}
  </span>
</template>

<script setup lang="ts">
import { Monitor, ChatLineSquare, ChatDotRound, Promotion, Connection } from '@element-plus/icons-vue';
import { conversationSources, type ConversationFeedItem } from './conversation-audit';
defineProps<{ source: ConversationFeedItem['source'] }>();
const icons = { client: Monitor, web: ChatLineSquare, wecom: ChatDotRound, delivery: Promotion, other: Connection };
</script>

<style scoped>
.sourceTag { display: inline-flex; align-items: center; gap: 4px; flex: none; padding: 1px 6px; font-size: 12px; line-height: 18px; font-weight: 600; color: var(--tag-ink, var(--el-text-color-regular)); background: color-mix(in srgb, currentColor 10%, var(--el-bg-color)); }
.source-client { --tag-ink: #345da5; }
.source-web { --tag-ink: #226f60; }
.source-wecom { --tag-ink: #7257a0; }
.source-delivery { --tag-ink: #895111; }
:global(html.dark .source-client) { --tag-ink: #9bbfff; }
:global(html.dark .source-web) { --tag-ink: #89d8be; }
:global(html.dark .source-wecom) { --tag-ink: #c8adf2; }
:global(html.dark .source-delivery) { --tag-ink: #efbf78; }
</style>
