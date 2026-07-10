// 后台 API 组合入口：账号态、权限闸门和通用配置 CRUD。
// 运行面、工具源、聊天入口和知识库后台已拆到独立模块；由 server.ts 主分发在鉴权后调用，返回 true=已处理。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { EngineRuntime } from '../app/engine';
import { readBody, send } from '../app/http';
import { type Principal, ROLE_PERMS, SESSION_COOKIE, can, permsOf, readCookie } from '../app/auth';
import { hashPassword, verifyPassword } from '../core/platform/password';
import { buildVersionInfo } from '../core/platform/version';
import { inspectConfig } from '../core/config/config-diagnostics';
import { runHubSmoke } from '../core/runtime/smoke-runtime';
import { handleAdminAccessApiFor } from './admin-access';
import { handleAdminChatApiFor } from './admin-chat';
import { handleAdminDispatchConfigApiFor } from './admin-dispatch-config';
import { handleAdminInfraApiFor } from './admin-infra';
import { handleAdminKbApiFor } from './admin-kb';
import { handleAdminRuntimeApiFor } from './admin-runtime';
import { handleAdminToolProviderApiFor } from './admin-tool-providers';
import { refreshTargets } from '../core/targets/registry';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { KbService } from '../services/kb';
import type { KbSyncService } from '../services/kbsync';
import type { ToolIndexService } from '../services/tools-index';
import type { ChannelMessage, ChannelSendResult } from '../app/channels';

export type AdminChannelSender = (channelName: string, recipient: string, message: string | ChannelMessage) => Promise<ChannelSendResult>;

export interface AdminApiDeps {
  cfg: AppConfig;
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  capabilities: unknown;
  kbService: KbService | null;
  kbSync: KbSyncService | null;
  toolIndex: ToolIndexService | null;
  isPaused: () => boolean;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  queueStats: () => unknown;
  channelSend: AdminChannelSender;
  engineRuntime: Pick<EngineRuntime, 'requeueForRerun'>;
  refreshTargets: typeof refreshTargets;
}

// ---- web 配置后台 API（管理项目/路由/接入方，查看任务）----
export async function handleAdminApiFor(deps: AdminApiDeps, method: string, path: string, req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<boolean> {
  if (!deps.configStore) { send(res, 400, { error: '配置后台需要 mysql 后端' }); return true; }
  const configStore = deps.configStore;

  if (path === '/admin/api/me' && method === 'GET') {
    send(res, 200, {
      username: principal.kind === 'admin' ? principal.username ?? '(token)' : '',
      via: principal.kind === 'admin' ? principal.via : '',
      role: principal.kind === 'admin' ? (principal.via === 'token' ? 'admin' : principal.role ?? 'admin') : '',
      perms: permsOf(principal),
      capabilities: deps.capabilities,
    });
    return true;
  }
  if (path === '/admin/api/capabilities' && method === 'GET') {
    send(res, 200, deps.capabilities);
    return true;
  }
  // 权限闸门：板块:动作 不在角色权限集内一律 403
  const deny = (): true => { send(res, 403, { error: '当前角色无此权限' }); return true; };
  const PERM_RULES: Array<[RegExp, string, string]> = [ // [路径, GET 所需权限, 写操作所需权限]
    [/^\/admin\/api\/projects/, 'projects:read', 'projects:write'],
    [/^\/admin\/api\/routes/, 'routes:read', 'routes:write'],
    [/^\/admin\/api\/runs/, 'runs:read', 'runs:write'], // 重跑是写操作：viewer 只能看不能跑
    [/^\/admin\/api\/threads/, 'runs:read', 'runs:read'], // 会话视图=运行面只读
    [/^\/admin\/api\/status/, 'runs:read', 'runs:read'],
    [/^\/admin\/api\/dispatch-status/, 'runs:read', 'runs:read'],
    [/^\/admin\/api\/config-schemas/, 'audit:read', 'audit:read'],
    [/^\/admin\/api\/cost/, 'runs:read', 'runs:read'], // 成本可观测=运行面只读
    [/^\/admin\/api\/clients/, 'clients:read', 'clients:write'],
    [/^\/admin\/api\/credentials/, 'credentials:read', 'credentials:write'],
    [/^\/admin\/api\/storage-buckets/, 'storage:read', 'storage:write'], // 含桶凭证，默认仅 admin（*）可管
    [/^\/admin\/api\/kb/, 'kb:read', 'kb:write'],
    [/^\/admin\/api\/admins/, 'admins:manage', 'admins:manage'],
    [/^\/admin\/api\/targets/, 'targets:read', 'targets:write'],
    [/^\/admin\/api\/config-audit/, 'audit:read', 'audit:read'],
    [/^\/admin\/api\/config-diagnostics/, 'audit:read', 'audit:read'],
    [/^\/admin\/api\/smoke/, 'audit:read', 'audit:read'],
    [/^\/admin\/api\/executors/, 'runs:read', 'runs:write'],
    [/^\/admin\/api\/executor-tokens/, 'runs:read', 'runs:write'],
    [/^\/admin\/api\/tool-providers/, 'tools:read', 'tools:write'],
    [/^\/admin\/api\/tool-approvals/, 'runs:read', 'runs:write'], // 审批是运行面操作不是配置面
    [/^\/admin\/api\/chat-entries/, 'routes:read', 'routes:write'], // 聊天入口=调度配置
    [/^\/admin\/api\/page-contexts/, 'routes:read', 'routes:write'], // 页面登记=调度配置（随聊天入口）
    [/^\/admin\/api\/chat-ratings/, 'runs:read', 'runs:read'],      // 评价=运行面只读数据
    [/^\/admin\/api\/channels/, 'channels:read', 'channels:write'], // 入站渠道（含平台密钥），默认仅 admin（*）可管
    [/^\/admin\/api\/alert-rules/, 'channels:read', 'channels:write'], // 告警通知规则（系统告警→渠道→收件人），随渠道权限
    [/^\/admin\/api\/delivery-dlq/, 'runs:read', 'runs:write'], // 送达死信队列（查看/重投），运行面操作
    [/^\/admin\/api\/version/, 'audit:read', 'audit:read'], // 版本/数据库结构状态：系统可观测
  ];
  for (const [re, readPerm, writePerm] of PERM_RULES) {
    if (!re.test(path)) continue;
    // hittest 是 POST 但本质是读（花的是检索费不是改数据）
    const isRead = method === 'GET' || /\/hittest$/.test(path) || path === '/admin/api/routes/auto-preview';
    if (!can(principal, isRead ? readPerm : writePerm)) return deny();
    break;
  }
  if (path === '/admin/api/password' && method === 'POST') {
    if (principal.kind !== 'admin' || principal.via !== 'session' || !principal.username) {
      send(res, 403, { error: '改密需要账号登录身份' }); return true;
    }
    const b = (await readBody(req)) as Record<string, unknown>;
    const oldPwd = String(b['old_password'] ?? ''); const newPwd = String(b['new_password'] ?? '');
    if (newPwd.length < 8) { send(res, 400, { error: '新密码至少 8 位' }); return true; }
    const admin = await configStore.admins.get(principal.username);
    if (!admin || !(await verifyPassword(oldPwd, admin.password_hash))) { send(res, 401, { error: '原密码错误' }); return true; }
    await configStore.admins.upsert(principal.username, await hashPassword(newPwd));
    await configStore.admins.deleteOtherSessions(principal.username, readCookie(req, SESSION_COOKIE)); // 其他登录态全部下线
    send(res, 200, { ok: true }); return true;
  }

  if (path === '/admin/api/version' && method === 'GET') {
    send(res, 200, buildVersionInfo(deps.cfg.root, await configStore.observability.listSchemaMigrations()));
    return true;
  }
  if (path === '/admin/api/config-diagnostics' && method === 'GET') {
    send(res, 200, await inspectConfig(configStore, { cfg: deps.cfg, kbService: deps.kbService }));
    return true;
  }
  if (path === '/admin/api/smoke' && method === 'POST') {
    const demo = await detectDemoSmokeTarget(configStore);
    const cookie = String(req.headers.cookie ?? '').trim();
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const tenantId = requestUrl.searchParams.get('tenant')?.trim() || readCookie(req, 'bz_tenant') || undefined;
    send(res, 200, await runHubSmoke({
      hub: `http://127.0.0.1:${deps.cfg.server.port}`,
      adminToken: deps.cfg.server.token || undefined,
      adminHeaders: cookie ? { cookie } : undefined,
      tenantId,
      runRoute: demo?.route,
      runToken: demo?.token,
      waitMs: 20_000,
    }));
    return true;
  }
  const mSchema = path.match(/^\/admin\/api\/config-schemas\/([a-z0-9-]+)$/);
  if (mSchema && method === 'GET') {
    const name = mSchema[1]!;
    const file = normalize(join(deps.cfg.root, 'schemas', 'config', `${name}.schema.json`));
    const base = normalize(join(deps.cfg.root, 'schemas', 'config')) + '/';
    if (!file.startsWith(base) || !existsSync(file)) { send(res, 404, { error: 'schema 不存在' }); return true; }
    send(res, 200, JSON.parse(readFileSync(file, 'utf8')) as unknown);
    return true;
  }

  if (await handleAdminRuntimeApiFor({
    configStore,
    stateStore: deps.stateStore,
    now: deps.now,
    isPaused: deps.isPaused,
    queueStats: deps.queueStats,
    channelSend: deps.channelSend,
    engineRuntime: deps.engineRuntime,
  }, method, path, req, res, principal)) return true;
  if (await handleAdminAccessApiFor({ configStore, stateStore: deps.stateStore, now: deps.now }, method, path, req, res, principal)) return true;
  if (await handleAdminToolProviderApiFor({ cfg: deps.cfg, configStore, stateStore: deps.stateStore, toolIndex: deps.toolIndex, now: deps.now, sleep: deps.sleep }, method, path, req, res, principal)) return true;
  if (await handleAdminChatApiFor({ configStore }, method, path, req, res)) return true;
  if (await handleAdminKbApiFor({ kbService: deps.kbService, kbSync: deps.kbSync, stateStore: deps.stateStore, now: deps.now }, method, path, req, res)) return true;
  if (await handleAdminInfraApiFor({ configStore }, method, path, req, res)) return true;
  if (await handleAdminDispatchConfigApiFor({ configStore, defaultProfile: deps.cfg.defaultProfile, refreshTargets: deps.refreshTargets }, method, path, req, res)) return true;

  // ---- 后台账号管理（admin 角色专属；权限闸门已在前面拦 admins:manage）----
  if (path === '/admin/api/admins') {
    if (method === 'GET') { send(res, 200, { list: await configStore.admins.list(), roles: Object.keys(ROLE_PERMS) }); return true; }
    if (method === 'POST') {
      const b = (await readBody(req)) as Record<string, unknown>;
      const username = String(b['username'] ?? '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(username)) { send(res, 400, { error: 'username 仅限字母/数字/中划线/下划线' }); return true; }
      const role = String(b['role'] ?? 'kb_editor');
      if (!ROLE_PERMS[role]) { send(res, 400, { error: `未知角色: ${role}（可选 ${Object.keys(ROLE_PERMS).join(' / ')}）` }); return true; }
      const password = String(b['password'] ?? '').trim();
      if (password && password.length < 8) { send(res, 400, { error: '密码至少 8 位' }); return true; }
      const existing = await configStore.admins.get(username);
      const displayName = b['display_name'] !== undefined ? String(b['display_name']) : undefined;
      if (!existing) {
        // 新建：没给密码就随机生成，只在本次响应里回显一次
        const pwd = password || randomPassword();
        await configStore.admins.upsert(username, await hashPassword(pwd), displayName ?? username, role);
        send(res, 200, { ok: true, username, role, generated_password: password ? undefined : pwd });
        return true;
      }
      // 已存在：改元信息；给了密码 = 重置密码并踢掉其全部会话
      await configStore.admins.updateMeta(username, { display_name: displayName, role, enabled: b['enabled'] !== false });
      if (password) { await configStore.admins.upsert(username, await hashPassword(password)); await configStore.admins.deleteSessionsFor(username); }
      if (b['enabled'] === false) await configStore.admins.deleteSessionsFor(username); // 停用立即生效
      send(res, 200, { ok: true, username, role });
      return true;
    }
  }
  if (path.startsWith('/admin/api/admins/') && method === 'DELETE') {
    const target = decodeURIComponent(path.slice('/admin/api/admins/'.length));
    if (principal.kind === 'admin' && principal.username === target) { send(res, 400, { error: '不能删除自己（防把最后一把钥匙锁进车里）' }); return true; }
    await configStore.admins.delete(target);
    send(res, 200, { ok: true }); return true;
  }

  return false;
}

function randomPassword(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

async function detectDemoSmokeTarget(configStore: ConfigStoreContract): Promise<{ route: string; token: string } | null> {
  const candidates = [
    { route: 'demo-after-sales', client: 'demo-business-app' },
    { route: 'demo_support', client: 'demo-app' },
  ];
  for (const c of candidates) {
    const [route, client] = await Promise.all([
      configStore.routes.get(c.route).catch(() => null),
      configStore.clients.get(c.client).catch(() => null),
    ]);
    if (!route?.enabled || !client?.enabled || !client.token) continue;
    const allowed = client.allowed_routes.includes('*') || client.allowed_routes.includes(route.route_key);
    if (allowed) return { route: route.route_key, token: client.token };
  }
  return null;
}
