<template>
  <el-container class="shell">
    <el-aside width="220px" class="aside">
      <BrandLockup class="brand" />
      <el-menu ref="menuRef" :default-active="route.path" :default-openeds="defaultOpeneds" router class="menu" @open="rememberGroupOpen" @close="rememberGroupClose">
        <el-menu-item v-for="it in primaryPages" :key="it.path" :index="'/' + it.path" class="primary-item">
          <el-icon><component :is="ICONS[it.path]" /></el-icon>
          <span>{{ it.title }}</span>
        </el-menu-item>
        <el-sub-menu v-for="g in groups" :key="g.title" :index="groupIndex(g.title)" class="menu-group">
          <template #title>
            <span class="group-title-text">{{ g.title }}</span>
          </template>
          <el-menu-item v-for="it in g.items" :key="it.path" :index="'/' + it.path">
            <el-icon><component :is="ICONS[it.path]" /></el-icon>
            <span>{{ it.title }}</span>
          </el-menu-item>
        </el-sub-menu>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="topbar" height="52px">
        <span class="page-title">{{ route.meta.title }}</span>
        <span class="spacer" />
        <span class="health" :class="{ bad: !healthy }">{{ healthy ? '中枢正常' : '中枢异常' }}</span>
        <span v-if="execText" class="health" :class="{ bad: execBad }">{{ execText }}</span>
        <el-dropdown v-if="configCenterPages.length" trigger="click" @command="onCmd">
          <span class="top-action">
            <el-icon><Setting /></el-icon>
            配置中心
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="it in configCenterPages" :key="it.path" :command="'nav:' + it.path">
                {{ it.title }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-dropdown @command="onCmd">
          <span class="user">
            {{ s.me?.username }}
            <el-tag v-if="s.me && s.me.role !== 'admin'" size="small" type="info" effect="plain">{{ s.me.role }}</el-tag>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-if="s.can('audit:read')" command="setup">上手向导</el-dropdown-item>
              <el-dropdown-item :divided="s.can('audit:read')" command="pwd">修改密码</el-dropdown-item>
              <el-dropdown-item divided command="logout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </el-header>
      <el-main class="main"><router-view /></el-main>
    </el-container>
  </el-container>

  <el-dialog v-model="pwdOpen" title="修改密码" width="380px">
    <el-form label-width="80px" @submit.prevent>
      <el-form-item label="原密码"><el-input v-model="pwdForm.old" type="password" show-password autocomplete="current-password" /></el-form-item>
      <el-form-item label="新密码"><el-input v-model="pwdForm.next" type="password" show-password autocomplete="new-password" placeholder="至少 8 位" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="pwdOpen = false">取消</el-button>
      <el-button type="primary" :loading="pwdSaving" @click="savePwd">改密并踢出其他登录</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="demoOpen" title="导入演示数据" width="520px" class="demo-dialog" :close-on-click-modal="false">
    <div class="demoBody">
      <p>当前实例还是空的。可以导入一批演示配置与运行痕迹，快速查看路由、工具源、任务追溯、审批意图和成本观测的完整心智。</p>
      <ul>
        <li>会写入当前实例，只用于快速理解后台结构与运行心智。</li>
        <li>演示对象使用 <code>demo-*</code> 前缀，可重复导入刷新，也可在上手向导里一键清理。</li>
        <li>真实接入时仍建议按自己的业务系统重新配置。</li>
      </ul>
    </div>
    <template #footer>
      <el-button @click="dismissDemo">暂不导入</el-button>
      <el-button type="primary" :loading="demoImporting" @click="importDemo">导入演示数据</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, markRaw, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus/es/components/message/index';
import { Box, ChatDotRound, Coin, Collection, Connection, Cpu, Document, Folder, InfoFilled, Key, Lock, Monitor, Promotion, SetUp, Setting, Stamp, Tickets, User, Warning } from '@element-plus/icons-vue';
import { useMe } from '../store';
import { PAGES } from '../router';
import { api } from '../request';
import BrandLockup from '../components/BrandLockup.vue';

const s = useMe();
const route = useRoute();
const router = useRouter();
const menuRef = ref<{ open: (index: string) => void } | null>(null);

const ICONS: Record<string, unknown> = {
  kb: markRaw(Collection), runs: markRaw(Tickets), executors: markRaw(Monitor), cost: markRaw(Coin), routes: markRaw(Connection), targets: markRaw(Cpu),
  tools: markRaw(SetUp), approvals: markRaw(Stamp), chat: markRaw(ChatDotRound), channels: markRaw(Promotion), projects: markRaw(Folder),
  clients: markRaw(Key), credentials: markRaw(Lock), storage: markRaw(Box), system: markRaw(InfoFilled), diagnostics: markRaw(Warning), accounts: markRaw(User), audit: markRaw(Document),
};
const GROUP_ORDER = ['场景配置', '接入入口', '能力装配', '运行', '基础资源', '系统管理'] as const;
const DEFAULT_OPEN_GROUPS = new Set<string>(['场景配置', '接入入口', '能力装配', '运行']);
const CONFIG_CENTER_PATHS = new Set<string>(['credentials', 'storage', 'projects', 'system', 'diagnostics', 'accounts']);
const MENU_OPEN_STORAGE_KEY = 'bailing:console:menu-open-groups:v1';
const primaryPages = computed(() => PAGES.filter((p) => p.group === '场景' && s.can(p.perm)));

// 菜单 = 权限过滤后的分组（后端接口另有二次拦截，这里只是体验层）
const groups = computed(() => {
  return GROUP_ORDER
    .map((title) => ({ title, items: PAGES.filter((p) => p.group === title && s.can(p.perm)) }))
    .filter((g) => g.items.length);
});
function groupIndex(title: string): string { return 'group:' + title; }
function groupTitle(index: string): string { return index.startsWith('group:') ? index.slice(6) : index; }
function readSavedOpenGroups(): Set<string> {
  try {
    const data = JSON.parse(localStorage.getItem(MENU_OPEN_STORAGE_KEY) || 'null');
    if (Array.isArray(data)) return new Set(data.filter((x) => typeof x === 'string'));
  } catch { /* ignore */ }
  return new Set(DEFAULT_OPEN_GROUPS);
}
const savedOpenGroups = ref(readSavedOpenGroups());
const activeGroup = computed(() => PAGES.find((p) => '/' + p.path === route.path)?.group ?? '');
const defaultOpeneds = computed(() => {
  const opened = new Set(savedOpenGroups.value);
  if (activeGroup.value) opened.add(activeGroup.value);
  return groups.value.filter((g) => opened.has(g.title)).map((g) => groupIndex(g.title));
});
const configCenterPages = computed(() => PAGES.filter((p) => CONFIG_CENTER_PATHS.has(p.path) && s.can(p.perm)));

watch(activeGroup, (group) => {
  if (!group) return;
  if (!groups.value.some((g) => g.title === group)) return;
  void nextTick(() => menuRef.value?.open(groupIndex(group)));
}, { immediate: true });

function saveOpenGroups(next: Set<string>): void {
  savedOpenGroups.value = new Set(next);
  localStorage.setItem(MENU_OPEN_STORAGE_KEY, JSON.stringify([...next]));
}
function rememberGroupOpen(index: string): void {
  const next = new Set(savedOpenGroups.value);
  next.add(groupTitle(index));
  saveOpenGroups(next);
}
function rememberGroupClose(index: string): void {
  const title = groupTitle(index);
  const next = new Set(savedOpenGroups.value);
  next.delete(title);
  saveOpenGroups(next);
}

const healthy = ref(true);
const execText = ref('');
const execBad = ref(false);
async function loadStatus(): Promise<void> {
  try { healthy.value = (await (await fetch('/health')).json()).status === 'ok'; }
  catch { healthy.value = false; }
  if (!s.can('runs:read')) return;
  try {
    const st = await api<{ executors: Array<{ executor_id: string; online: boolean }> }>('/admin/api/status');
    const on = st.executors.filter((e) => e.online).length;
    const off = st.executors.length - on;
    execText.value = st.executors.length ? `执行器 ${on}/${st.executors.length} 在线` : '';
    execBad.value = off > 0;
  } catch { /* 状态条可选 */ }
}
onMounted(() => {
  void loadStatus();
  void loadDemoDatasetStatus();
  setInterval(() => void loadStatus(), 60_000);
});

const pwdOpen = ref(false);
const pwdSaving = ref(false);
const pwdForm = reactive({ old: '', next: '' });
const demoOpen = ref(false);
const demoImporting = ref(false);
const demoStatus = ref<any | null>(null);

function demoDismissKey(): string {
  return `bailing:demo-dataset:dismissed:${s.me?.username ?? 'anonymous'}`;
}

async function loadDemoDatasetStatus(): Promise<void> {
  if (!s.me || !s.can('routes:write')) return;
  try {
    const status = await api<any>('/admin/api/demo-dataset/status');
    demoStatus.value = status;
    if (status?.available && !status.imported && status.empty && localStorage.getItem(demoDismissKey()) !== '1') {
      demoOpen.value = true;
    }
  } catch {
    demoStatus.value = null;
  }
}

function dismissDemo(): void {
  localStorage.setItem(demoDismissKey(), '1');
  demoOpen.value = false;
}

async function importDemo(): Promise<void> {
  demoImporting.value = true;
  try {
    demoStatus.value = await api('/admin/api/demo-dataset/import', { method: 'POST', body: '{}' });
    localStorage.removeItem(demoDismissKey());
    demoOpen.value = false;
    window.dispatchEvent(new CustomEvent('bailing-demo-dataset-imported'));
    ElMessage.success('演示数据已导入');
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    demoImporting.value = false;
  }
}
async function savePwd(): Promise<void> {
  pwdSaving.value = true;
  try {
    await api('/admin/api/password', { method: 'POST', body: JSON.stringify({ old_password: pwdForm.old, new_password: pwdForm.next }) });
    ElMessage.success('密码已修改，其他设备的登录已全部下线');
    pwdOpen.value = false; pwdForm.old = ''; pwdForm.next = '';
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { pwdSaving.value = false; }
}

async function onCmd(cmd: string): Promise<void> {
  if (cmd.startsWith('nav:')) { void router.push('/' + cmd.slice(4)); return; }
  if (cmd === 'setup') void router.push('/setup');
  if (cmd === 'pwd') pwdOpen.value = true;
  if (cmd === 'logout') { await s.logout(); void router.push('/login'); }
}
</script>

<style scoped>
.shell { height: 100%; }
/* aside 自身不滚（el-aside 默认 overflow:auto 会冒出竖向滚动条）；brand 固定，仅 menu 区域吃溢出 */
.aside { background: #0c0e11; border-right: 1px solid var(--el-border-color-lighter); display: flex; flex-direction: column; overflow: hidden; }
.brand {
  --bz-brand-mark-main: #238636;
  --bz-brand-mark-accent: #2ea043;
  width: 150px;
  height: 50px;
  margin: 10px 10px 0;
  flex: none;
}
/* 菜单占满剩余高度并隐藏滚动条：短屏仍可滚轮/触控板滚动（不丢菜单项），但不显示难看的滚动条 */
.menu { border-right: none; flex: 1; overflow-y: auto; padding: 2px 0 16px; scrollbar-width: none; -ms-overflow-style: none; }
.menu::-webkit-scrollbar { width: 0; height: 0; }
.menu :deep(.el-menu) { background: transparent; }
.menu :deep(.el-sub-menu__title),
.menu :deep(.el-menu-item) {
  color: var(--el-text-color-secondary);
  border-radius: 0;
}
.menu :deep(.primary-item) {
  height: 54px;
  line-height: 54px;
  margin: 10px 0 20px;
  padding-left: 20px !important;
  font-weight: 700;
  color: var(--el-text-color-primary);
  background: transparent;
  border-left: 3px solid transparent;
}
.menu :deep(.primary-item.is-active) {
  background: rgba(63, 185, 80, .18);
  color: var(--el-color-primary);
  border-left-color: rgba(63, 185, 80, .78);
}
.menu :deep(.menu-group) { margin: 0 0 14px; }
.menu :deep(.el-sub-menu__title) {
  height: 32px;
  line-height: 32px;
  padding-left: 20px !important;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .02em;
  color: var(--el-text-color-placeholder);
  background: transparent;
  border-left: 3px solid transparent;
}
.menu :deep(.el-sub-menu__title:hover) {
  background: transparent;
  color: var(--el-text-color-primary);
}
.menu :deep(.el-menu-item) {
  height: 44px;
  line-height: 44px;
}
.menu :deep(.el-sub-menu .el-menu) {
  margin: 0;
  padding: 2px 0 12px;
  background: transparent;
}
.menu :deep(.el-sub-menu .el-menu-item) {
  height: 46px;
  line-height: 46px;
  margin: 2px 0;
  padding-left: 20px !important;
  font-size: 14px;
  color: var(--el-text-color-secondary);
  border-left: 3px solid transparent;
}
.menu :deep(.el-menu-item:hover),
.menu :deep(.el-menu-item.is-active) {
  background: rgba(63, 185, 80, .14);
  color: var(--el-color-primary);
}
.menu :deep(.el-menu-item.is-active) {
  font-weight: 650;
  border-left-color: rgba(63, 185, 80, .78);
}
.menu :deep(.el-sub-menu.is-opened > .el-sub-menu__title) {
  color: var(--el-text-color-secondary);
  background: transparent;
}
.menu :deep(.el-sub-menu__icon-arrow) {
  right: 18px;
  color: var(--el-text-color-placeholder);
}
.topbar { display: flex; align-items: center; gap: 14px; background: #0c0e11; border-bottom: 1px solid var(--el-border-color-lighter); }
.page-title { font-size: 15px; font-weight: 600; }
.spacer { flex: 1; }
.health { font-size: 12px; color: var(--el-color-success); }
.health.bad { color: var(--el-color-danger); }
.top-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  color: var(--el-text-color-secondary);
  border: 1px solid var(--el-border-color-lighter);
  cursor: pointer;
  font-size: 13px;
}
.top-action:hover {
  color: var(--el-color-primary);
  border-color: rgba(63, 185, 80, .42);
  background: rgba(63, 185, 80, .08);
}
.user { cursor: pointer; font-size: 13px; display: inline-flex; align-items: center; gap: 4px; }
.demoBody { display: flex; flex-direction: column; gap: 10px; color: var(--el-text-color-regular); line-height: 1.7; }
.demoBody p { margin: 0; }
.demoBody ul { margin: 0; padding-left: 18px; }
.demoBody code { font-family: var(--bz-mono); background: var(--el-fill-color-light); padding: 1px 4px; }
/* 内容区全宽铺满，与顶栏对齐——居中收口在超宽屏下跟全宽顶栏错位，反而奇怪。 */
.main { width: 100%; padding: 24px 28px; }
</style>
