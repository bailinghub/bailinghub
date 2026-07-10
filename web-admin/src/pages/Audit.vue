<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>变更审计</b> <HelpTip title="变更审计是什么">
          <p>记录控制台配置被谁修改、何时修改、作用到哪个配置对象。用于追溯路由、凭证、接入方、账号、知识库、目标等配置变更。</p>
          <p>这是配置审计，不是任务执行 trace；任务执行过程请到「任务」查看。</p>
        </HelpTip>
        <el-button style="margin-left: auto" :loading="loading" @click="load">刷新</el-button></div>
    </template>
    <el-empty v-if="!list.length && !loading" description="暂无配置变更记录" />
    <el-table v-else :data="list" v-loading="loading">
      <el-table-column label="变更事件" min-width="260" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="audit-main">
            <b>{{ row.by || '未知操作人' }}</b>
            <span class="muted">{{ fmtTime(row.ts, true) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="配置对象" min-width="360" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="audit-stack">
            <code>{{ objectLabel(row.path) }}</code>
            <span class="muted mono">{{ row.path }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="动作" width="110" align="center">
        <template #default="{ row }">
          <el-tag :type="row.method === 'DELETE' ? 'danger' : 'success'" effect="plain">{{ actionLabel(row.method) }}</el-tag>
        </template>
      </el-table-column>
    </el-table>
    <div v-if="more" class="loadmore"><el-button :loading="moreLoading" @click="loadMore">加载更多</el-button></div>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../request';
import { fmtTime } from '../util';
import HelpTip from '../components/HelpTip.vue';

const PAGE = 100;
const list = ref<any[]>([]);
const loading = ref(false);
const more = ref(false);
const moreLoading = ref(false);
function objectLabel(path: string): string {
  const p = String(path || '');
  return p
    .replace(/^\/admin\/api\//, '')
    .replace(/^routes/, '触发路由')
    .replace(/^clients/, '接入方')
    .replace(/^credentials/, '模型凭证')
    .replace(/^tool-providers/, '工具源')
    .replace(/^targets/, '调度目标')
    .replace(/^executor-tokens/, '执行器令牌')
    .replace(/^storage-buckets/, '对象存储')
    .replace(/^admins/, '后台账号')
    .replace(/^kb/, '知识库');
}
function actionLabel(method: string): string {
  if (method === 'DELETE') return '删除';
  if (method === 'POST') return '保存';
  if (method === 'PUT') return '更新';
  return method || '变更';
}
async function load(): Promise<void> {
  loading.value = true;
  try {
    const rows = await api<any[]>(`/admin/api/config-audit?limit=${PAGE}&offset=0`);
    list.value = rows; more.value = rows.length === PAGE;
  } finally { loading.value = false; }
}
async function loadMore(): Promise<void> {
  moreLoading.value = true;
  try {
    const rows = await api<any[]>(`/admin/api/config-audit?limit=${PAGE}&offset=${list.value.length}`);
    list.value = list.value.concat(rows); more.value = rows.length === PAGE;
  } finally { moreLoading.value = false; }
}
onMounted(load);
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.loadmore { text-align: center; padding: 12px 0 4px; }
.audit-main,
.audit-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  line-height: 1.35;
}
.audit-main b,
.audit-stack code,
.audit-stack span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.audit-main b { color: var(--el-text-color-primary); font-size: 13px; }
.audit-stack code { color: var(--el-text-color-primary); font-family: var(--bz-mono); font-size: 12px; }
</style>
