import { createRouter, createWebHistory } from 'vue-router';
import { ElMessage } from 'element-plus/es/components/message/index';
import { useMe } from './store';

export const SETUP_PAGE = { path: 'setup', perm: 'audit:read', title: '上手向导' } as const;

// 页面与所需权限（菜单渲染同源于此；后端接口另有二次拦截）。
// 数组顺序 = 菜单显示顺序，也是常规默认落地优先级（进 `/` 落到第一个有权限的页 → 任务）。
// 分组按「日常使用频率 + 概念角色」切：任务(运行入口) → 场景配置 → 入口(谁/从哪触发) → 能力(引用的积木) → 基础资源(低频公共配置) → 运行治理 → 系统(平台管理)。
// 上手向导是首次接入与低频自检入口，不常驻左侧主导航；路由保留，入口收敛到默认落地与右上角菜单。
export const PAGES = [
  // ① 任务 —— 稳定运行后的默认工作台
  { path: 'runs', perm: 'runs:read', title: '任务', group: '场景' },
  // ② 场景配置 —— 装配中心，配置频率低于运行观测
  { path: 'routes', perm: 'routes:read', title: '触发路由', group: '场景配置' },
  // ③ 接入入口 —— 场景怎么被触发（谁/从哪触发）
  { path: 'clients', perm: 'clients:read', title: '接入方', group: '接入入口' },
  { path: 'chat', perm: 'routes:read', title: '聊天入口', group: '接入入口' },
  { path: 'channels', perm: 'channels:read', title: '入站渠道', group: '接入入口' },
  // ④ 能力 —— 场景可引用的积木
  { path: 'targets', perm: 'targets:read', title: '调度目标', group: '能力装配' },
  { path: 'tools', perm: 'tools:read', title: '工具源', group: '能力装配' },
  { path: 'kb', perm: 'kb:read', title: '知识库', group: '能力装配' },
  // ⑤ 基础资源 —— 配一次、多处复用的低频公共配置
  { path: 'credentials', perm: 'credentials:read', title: '模型凭证', group: '基础资源' },
  { path: 'storage', perm: 'storage:read', title: '媒体存储', group: '基础资源' },
  { path: 'projects', perm: 'projects:read', title: '项目目录', group: '基础资源' },
  // ⑥ 运行治理 —— 非默认运行配置与治理观察
  { path: 'executors', perm: 'runs:read', title: '执行器', group: '运行' },
  { path: 'cost', perm: 'runs:read', title: '成本观测', group: '运行' },
  { path: 'approvals', perm: 'runs:read', title: '审批意图', group: '运行' },
  // ⑦ 系统 —— 平台管理（低频）
  { path: 'system', perm: 'audit:read', title: '系统状态', group: '系统管理' },
  { path: 'diagnostics', perm: 'audit:read', title: '系统体检', group: '系统管理' },
  { path: 'accounts', perm: 'admins:manage', title: '后台账号', group: '系统管理' },
  { path: 'audit', perm: 'audit:read', title: '变更审计', group: '系统管理' },
] as const;

export const router = createRouter({
  history: createWebHistory('/console/'),
  routes: [
    { path: '/login', component: () => import('./pages/Login.vue') },
    {
      path: '/',
      component: () => import('./layout/Shell.vue'),
      children: [
        { path: 'setup', component: () => import('./pages/Setup.vue'), meta: { perm: SETUP_PAGE.perm, title: SETUP_PAGE.title } },
        { path: 'kb', component: () => import('./pages/Kb.vue'), meta: { perm: 'kb:read', title: '知识库' } },
        { path: 'runs', component: () => import('./pages/Runs.vue'), meta: { perm: 'runs:read', title: '任务' } },
        { path: 'executors', component: () => import('./pages/Executors.vue'), meta: { perm: 'runs:read', title: '执行器' } },
        { path: 'cost', component: () => import('./pages/Cost.vue'), meta: { perm: 'runs:read', title: '成本观测' } },
        { path: 'routes', component: () => import('./pages/Routes.vue'), meta: { perm: 'routes:read', title: '触发路由' } },
        { path: 'targets', component: () => import('./pages/Targets.vue'), meta: { perm: 'targets:read', title: '调度目标' } },
        { path: 'tools', component: () => import('./pages/Tools.vue'), meta: { perm: 'tools:read', title: '工具源' } },
        { path: 'approvals', component: () => import('./pages/Approvals.vue'), meta: { perm: 'runs:read', title: '审批意图' } },
        { path: 'chat', component: () => import('./pages/ChatEntries.vue'), meta: { perm: 'routes:read', title: '聊天入口' } },
        { path: 'channels', component: () => import('./pages/Channels.vue'), meta: { perm: 'channels:read', title: '入站渠道' } },
        { path: 'projects', component: () => import('./pages/Projects.vue'), meta: { perm: 'projects:read', title: '项目目录' } },
        { path: 'clients', component: () => import('./pages/Clients.vue'), meta: { perm: 'clients:read', title: '接入方' } },
        { path: 'credentials', component: () => import('./pages/Credentials.vue'), meta: { perm: 'credentials:read', title: '模型凭证' } },
        { path: 'storage', component: () => import('./pages/StorageBuckets.vue'), meta: { perm: 'storage:read', title: '媒体存储' } },
        { path: 'system', component: () => import('./pages/SystemStatus.vue'), meta: { perm: 'audit:read', title: '系统状态' } },
        { path: 'diagnostics', component: () => import('./pages/Diagnostics.vue'), meta: { perm: 'audit:read', title: '系统体检' } },
        { path: 'accounts', component: () => import('./pages/Accounts.vue'), meta: { perm: 'admins:manage', title: '后台账号' } },
        { path: 'audit', component: () => import('./pages/Audit.vue'), meta: { perm: 'audit:read', title: '变更审计' } },
      ],
    },
  ],
});

async function readAdminList<T = Record<string, unknown>>(path: string): Promise<T[]> {
  const r = await fetch(path);
  if (r.status === 401) throw new Error('unauthorized');
  if (!r.ok) return [];
  const data = await r.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

async function shouldEnterSetup(s: ReturnType<typeof useMe>): Promise<boolean> {
  if (!s.can(SETUP_PAGE.perm)) return false;
  const [credentials, targets, providers, clients, routes] = await Promise.all([
    s.can('credentials:read') ? readAdminList('/admin/api/credentials') : Promise.resolve([{}]),
    s.can('targets:read') ? readAdminList<{ name?: string }>('/admin/api/targets') : Promise.resolve([{}]),
    s.can('tools:read') ? readAdminList('/admin/api/tool-providers') : Promise.resolve([{}]),
    s.can('clients:read') ? readAdminList('/admin/api/clients') : Promise.resolve([{}]),
    s.can('routes:read') ? readAdminList('/admin/api/routes') : Promise.resolve([{}]),
  ]);
  const hasDemoTarget = targets.some((t) => (t as { name?: string }).name === 'demo-agent');
  return routes.length === 0 || clients.length === 0 || targets.length === 0 || providers.length === 0 || (credentials.length === 0 && !hasDemoTarget);
}

router.beforeEach(async (to) => {
  const s = useMe();
  if (!s.fetched) await s.fetch().catch(() => null);
  if (to.path === '/login') return s.me ? '/' : true;
  if (!s.me) return { path: '/login', query: to.query };
  if (to.path === '/') {
    try {
      if (await shouldEnterSetup(s)) return '/' + SETUP_PAGE.path;
    } catch {
      await s.logout();
      return { path: '/login', query: to.query };
    }
    const first = PAGES.find((p) => s.can(p.perm));
    if (!first) { await s.logout(); return { path: '/login', query: to.query }; } // 零权限账号（不应出现）
    return '/' + first.path;
  }
  if (to.meta['perm'] && !s.can(to.meta['perm'] as string)) return '/';
  return true;
});

function isChunkLoadError(err: unknown): boolean {
  const message = String((err as { message?: unknown })?.message || err || '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk \d+ failed|ChunkLoadError/i.test(message);
}

function reloadForFreshAssets(): void {
  const key = 'bailing:console:asset-reload:v1';
  if (sessionStorage.getItem(key) === '1') {
    ElMessage.error('控制台资源已更新，请手动刷新页面');
    return;
  }
  sessionStorage.setItem(key, '1');
  ElMessage.warning('控制台已更新，正在刷新页面');
  setTimeout(() => window.location.reload(), 300);
}

router.onError((err) => {
  if (isChunkLoadError(err)) reloadForFreshAssets();
});

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    reloadForFreshAssets();
  });
}
