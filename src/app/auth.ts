// 鉴权 / 会话 / RBAC / 限速：admin（运营方）与 client（接入方）两种身份。
// admin 两条路：Cookie 会话（人·后台账号密码登录）/ server.token（机器·执行器与运维脚本）。
// client = bz_clients 的 per-caller token（业务系统，只能走 /run + 查自己的 job）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ipOf, readBody, send } from './http';
import { verifyPassword } from '../core/platform/password';
import type { Client, ExecutorToken } from '../core/contracts/types';
import type { AppConfig } from '../core/config/config';
import { allowsUnauthenticatedLocalDevelopment } from '../core/platform/server-token';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export type Principal =
  | { kind: 'admin'; via: 'session' | 'token'; username?: string; role?: string }
  | { kind: 'client'; client: Client }
  | { kind: 'executor'; token: ExecutorToken };

export interface AuthRuntimeDeps {
  cfg: AppConfig;
  configStore: ConfigStoreContract | null;
}

// ---- RBAC：固定角色先行（要细粒度/自定义角色时，把权限集搬进库即可，结构不用动）----
// 权限键 = 板块:动作。前端按 /admin/api/me 返回的 perms 画菜单；后端每个接口组同步校验（藏菜单不是安全，拦截才是）。
export const ROLE_PERMS: Record<string, string[]> = {
  admin: ['*'],
  kb_editor: ['kb:read', 'kb:write'],            // 客服/运维：维护知识库
  viewer: ['runs:read'],                          // 只读看任务
};
export function permsOf(p: Principal): string[] {
  if (p.kind !== 'admin') return [];
  if (p.via === 'token') return ['*']; // server.token = 机器全能（执行器/运维脚本）
  return ROLE_PERMS[p.role ?? 'admin'] ?? [];
}
export function can(p: Principal, perm: string): boolean {
  const ps = permsOf(p);
  return ps.includes('*') || ps.includes(perm);
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天滑动续期
export const SESSION_COOKIE = 'bz_sess';

export function presentedToken(req: IncomingMessage, url: URL): string {
  const bearer = (req.headers['authorization'] ?? '').toString().replace(/^Bearer\s+/i, '');
  return bearer || (url.searchParams.get('token') ?? '');
}

export function readCookie(req: IncomingMessage, name: string): string {
  const raw = (req.headers['cookie'] ?? '').toString();
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function requestIsHttps(req: IncomingMessage): boolean {
  const forwardedProto = (req.headers['x-forwarded-proto'] ?? '').toString().split(',')[0]?.trim().toLowerCase();
  return forwardedProto === 'https' || Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

export function sessionCookieHeader(req: IncomingMessage, sid: string, maxAgeSec: number): string {
  const secure = requestIsHttps(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function setSessionCookie(req: IncomingMessage, res: ServerResponse, sid: string, maxAgeSec: number): void {
  res.setHeader('set-cookie', sessionCookieHeader(req, sid, maxAgeSec));
}

export async function authenticateFor(deps: AuthRuntimeDeps, req: IncomingMessage, url: URL): Promise<Principal | null> {
  // 1) Cookie 会话（人）
  if (deps.configStore) {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid) {
      const sess = await deps.configStore.admins.getSession(sid, SESSION_TTL_MS);
      if (sess) return { kind: 'admin', via: 'session', username: sess.username, role: sess.role };
    }
  }
  if (!deps.cfg.server.token) {
    // 无鉴权开发模式只允许绑定本机回环地址；loadConfig 也会对其他部署 fail-closed。
    return allowsUnauthenticatedLocalDevelopment(deps.cfg.env, deps.cfg.server.host)
      ? { kind: 'admin', via: 'token', username: 'dev' }
      : null;
  }
  const token = presentedToken(req, url);
  if (!token) return null;
  // 2) 管理 token（机器：执行器 / 运维脚本）
  if (token === deps.cfg.server.token) return { kind: 'admin', via: 'token' };
  // 3) 接入方 token（业务系统）
  if (deps.configStore) {
    const client = await deps.configStore.clients.getByToken(token);
    if (client && client.enabled) return { kind: 'client', client };
  }
  // 4) 执行器令牌（挂执行器的机器：claim/result 专用，按 target 白名单授权，替代共享管理员 token）
  if (deps.configStore) {
    const et = await deps.configStore.executorTokens.getByToken(token);
    if (et && et.enabled) return { kind: 'executor', token: et };
  }
  return null;
}

/** Cookie 会话的写操作做同源校验（防 CSRF）；无 Origin/Referer 的请求（curl 等）放行——它们本就带不上浏览器 Cookie。 */
export function originOk(req: IncomingMessage): boolean {
  const o = (req.headers['origin'] ?? req.headers['referer'] ?? '').toString();
  if (!o) return true;
  try { return new URL(o).host === (req.headers['host'] ?? '').toString(); } catch { return false; }
}

// 本地/jsonl 兜底；mysql 后端使用 bz_rate_limits，支持多实例共享限速。
const loginFails = new Map<string, { n: number; until: number }>();
function loginKey(req: IncomingMessage, username: string): string {
  return `login:${ipOf(req)}|${username}`;
}

function fallbackLoginLocked(key: string): boolean {
  const fail = loginFails.get(key);
  return !!fail && fail.n >= 5 && Date.now() < fail.until;
}

function fallbackLoginRecord(key: string): void {
  const cur = loginFails.get(key) ?? { n: 0, until: 0 };
  loginFails.set(key, { n: cur.n + 1, until: Date.now() + 10 * 60_000 });
}

async function loginLockedFor(configStore: ConfigStoreContract | null, key: string): Promise<boolean> {
  if (configStore) return (await configStore.rateLimits.count(key, 10 * 60)) >= 5;
  return fallbackLoginLocked(key);
}

async function recordLoginFailureFor(configStore: ConfigStoreContract | null, key: string): Promise<void> {
  if (configStore) { await configStore.rateLimits.record(key); return; }
  fallbackLoginRecord(key);
}

async function clearLoginFailuresFor(configStore: ConfigStoreContract | null, key: string): Promise<void> {
  if (configStore) { await configStore.rateLimits.clear(key); return; }
  loginFails.delete(key);
}

export async function handleLoginFor(deps: AuthRuntimeDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!deps.configStore) { send(res, 400, { error: '账号登录需要 mysql 后端' }); return; }
  const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
  const username = String(body['username'] ?? '').trim();
  const password = String(body['password'] ?? '');
  if (!username || !password) { send(res, 400, { error: '用户名/密码必填' }); return; }
  const key = loginKey(req, username);
  if (await loginLockedFor(deps.configStore, key)) { send(res, 429, { error: '失败次数过多，10 分钟后再试' }); return; }
  const admin = await deps.configStore.admins.get(username);
  if (!admin || !admin.enabled || !(await verifyPassword(password, admin.password_hash))) {
    await recordLoginFailureFor(deps.configStore, key);
    send(res, 401, { error: '用户名或密码错误' });
    return;
  }
  await clearLoginFailuresFor(deps.configStore, key);
  const sid = await deps.configStore.admins.createSession(username, SESSION_TTL_MS);
  await deps.configStore.admins.markLogin(username);
  setSessionCookie(req, res, sid, SESSION_TTL_MS / 1000);
  send(res, 200, { ok: true, username, display_name: admin.display_name ?? username });
}

export async function handleLogoutFor(deps: AuthRuntimeDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sid = readCookie(req, SESSION_COOKIE);
  if (sid && deps.configStore) await deps.configStore.admins.deleteSession(sid).catch(() => { /* 容错 */ });
  setSessionCookie(req, res, '', 0);
  send(res, 200, { ok: true });
}

export function clientAllowsRoute(client: Client, routeKey: string): boolean {
  return client.allowed_routes.includes('*') || client.allowed_routes.includes(routeKey);
}

/** 接入方主动出站（POST /send）的渠道白名单。空数组=禁止（fail-closed，必须显式授权某渠道才能往它推）。 */
export function clientAllowsChannel(client: Client, channelName: string): boolean {
  return client.allowed_channels.includes('*') || client.allowed_channels.includes(channelName);
}

// 接入方限速：mysql 后端使用集中账本；本地/jsonl 仍使用进程内滑窗兜底。
const rateWindows = new Map<string, number[]>();
function memoryRateLimited(bucket: string, limit: number): boolean {
  const nowMs = Date.now();
  const win = (rateWindows.get(bucket) ?? []).filter((t) => nowMs - t < 60_000);
  if (win.length >= limit) { rateWindows.set(bucket, win); return true; }
  win.push(nowMs);
  rateWindows.set(bucket, win);
  return false;
}

export async function rateLimitedFor(config: ConfigStoreContract | null, client: Client): Promise<boolean> {
  if (!client.rate_limit_per_min) return false;
  const bucket = `client:${client.app_id}`;
  if (config) return await config.rateLimits.consume(bucket, client.rate_limit_per_min, 60);
  return memoryRateLimited(bucket, client.rate_limit_per_min);
}

export async function namedRateLimitedFor(config: ConfigStoreContract | null, bucket: string, limit: number, windowSec = 60): Promise<boolean> {
  if (!limit) return false;
  if (config) return await config.rateLimits.consume(bucket, limit, windowSec);
  return memoryRateLimited(bucket, limit);
}
