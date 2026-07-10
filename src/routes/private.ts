// 私有/受控 HTTP 面：公开静态与网页聊天之外的所有入口。
// 包含：平台签名入口、业务侧审批回调、登录态、工具 token 面、统一鉴权后的 admin/executor/client API。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { now, send, sleep } from '../app/http';
import { authenticateFor, can, handleLoginFor, handleLogoutFor, originOk, presentedToken, rateLimitedFor, type AuthRuntimeDeps, type Principal } from '../app/auth';
import { handleToolDefsFor, handleToolInvokeFor, type ToolProxyDeps } from '../app/tool-proxy';
import type { KbApiDeps } from './kb';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { KbService } from '../services/kb';
import type { ToolIndexService } from '../services/tools-index';

export interface PrivateHttpDeps extends AuthRuntimeDeps {
  cfg: AppConfig;
  stateStore: RuntimeStateStore;
  kbService: KbService | null;
  toolIndex: ToolIndexService | null;
  handleAdminApi(method: string, path: string, req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<boolean>;
  handleApprovalDecision(req: IncomingMessage, res: ServerResponse, approvalId: number, url: URL): Promise<void>;
  handleExecutorClaim(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void>;
  handleExecutorHeartbeat(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void>;
  handleExecutorResult(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleKbSearchFor(deps: KbApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleKbIngestFor(deps: KbApiDeps, req: IncomingMessage, res: ServerResponse, principal: Principal, method: string, kbId: string, sourceKey: string): Promise<void>;
  handleKbIngestListFor(deps: KbApiDeps, res: ServerResponse, principal: Principal, kbId: string): Promise<void>;
  handleRun(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void>;
  handleSend(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void>;
  handleWecomInbound(req: IncomingMessage, res: ServerResponse, accountId: string, url: URL): Promise<void>;
}

function kbApiDeps(deps: PrivateHttpDeps): KbApiDeps {
  return { kbService: deps.kbService, stateStore: deps.stateStore, configStore: deps.configStore, now };
}

function toolProxyDeps(deps: PrivateHttpDeps): ToolProxyDeps {
  return { cfg: deps.cfg, configStore: deps.configStore, stateStore: deps.stateStore, toolIndex: deps.toolIndex, now, sleep };
}

export async function handlePrivateHttpFor(deps: PrivateHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // 企微入站（公开面，自带验签，不走 admin/接入方鉴权）：GET 验 URL / POST 收消息。
  const mWecom = (method === 'GET' || method === 'POST') ? path.match(/^\/wecom\/([a-zA-Z0-9_-]{2,64})$/) : null;
  if (mWecom) { await deps.handleWecomInbound(req, res, mWecom[1]!, url); return; }

  // 业务侧审批决策回调：不走中枢后台账号；用触发方 token 或签名验证，见 routes/approvals.ts。
  const mApprovalDecision = method === 'POST' ? path.match(/^\/approvals\/(\d+)\/decision$/) : null;
  if (mApprovalDecision) { await deps.handleApprovalDecision(req, res, Number(mApprovalDecision[1]), url); return; }

  if (method === 'POST' && path === '/admin/login') { await handleLoginFor(deps, req, res); return; }
  if (method === 'POST' && path === '/admin/logout') { await handleLogoutFor(deps, req, res); return; }

  // 统一工具面调用代理：凭任务级 tool_token 鉴权（不走 admin/client 体系）。
  const mInvoke = method === 'POST' ? path.match(/^\/jobs\/([0-9a-f-]{36})\/tools\/invoke$/) : null;
  if (mInvoke) { await handleToolInvokeFor(toolProxyDeps(deps), req, res, mInvoke[1]!, presentedToken(req, url)); return; }
  // 渐进披露取定义（执行器大脑凭 tool_token，?names=a,b 逗号分隔）。
  const mDefs = method === 'GET' ? path.match(/^\/jobs\/([0-9a-f-]{36})\/tools\/defs$/) : null;
  if (mDefs) {
    const names = String(url.searchParams.get('names') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    await handleToolDefsFor(toolProxyDeps(deps), req, res, mDefs[1]!, presentedToken(req, url), names);
    return;
  }

  const principal = await authenticateFor(deps, req, url);
  if (!principal) { send(res, 401, { error: 'unauthorized' }); return; }
  const isAdmin = principal.kind === 'admin';

  // Cookie 会话的写操作做同源校验（防 CSRF）。
  if (method !== 'GET' && principal.kind === 'admin' && principal.via === 'session' && !originOk(req)) {
    send(res, 403, { error: '跨站请求被拒绝' }); return;
  }

  // 执行器通道（claim/result/heartbeat）：接受专用执行器令牌或管理员 token。
  if (path === '/executor/claim' || path === '/executor/result' || path === '/executor/heartbeat') {
    const machineOk = principal.kind === 'executor' || (principal.kind === 'admin' && principal.via === 'token');
    if (method !== 'POST' || !machineOk) { send(res, 403, { error: '执行器通道需专用执行器令牌或管理员 token' }); return; }
    if (path === '/executor/claim') { await deps.handleExecutorClaim(req, res, principal); return; }
    if (path === '/executor/heartbeat') { await deps.handleExecutorHeartbeat(req, res, principal); return; }
    await deps.handleExecutorResult(req, res); return;
  }

  // admin 专属面：后台 API / kill switch。接入方 token 与执行器令牌到不了这里。
  if (path.startsWith('/admin/')) {
    if (!isAdmin) { send(res, 403, { error: '该接口仅限管理身份' }); return; }
    if (path.startsWith('/admin/api/')) {
      const handled = await deps.handleAdminApi(method, path, req, res, principal);
      if (handled) {
        // 配置变更审计：成功的写操作集中记一笔。不记请求体（里面可能有密钥）。
        if (method !== 'GET' && res.statusCode === 200 && !/\/hittest$/.test(path) && !/\/datasources\/(test|\d+\/sync)$/.test(path) && !path.startsWith('/admin/api/runs') && !path.startsWith('/admin/api/tool-approvals')) {
          const by = principal.kind === 'admin' ? principal.username ?? 'token' : 'client';
          void deps.stateStore.appendAudit({
            ts: now(), job_id: '-', request_id: 'config', event: 'config_change',
            detail: { by, method, path: path.slice('/admin/api/'.length) },
          }).catch(() => { /* 审计失败不影响操作本身 */ });
        }
        return;
      }
      send(res, 404, { error: 'not found' });
      return;
    }
    if (method === 'POST' && path === '/admin/pause') {
      if (!can(principal, 'system:write')) { send(res, 403, { error: '当前角色无此权限' }); return; }
      writeFileSync(deps.cfg.killSwitchFile, now()); send(res, 200, { paused: true }); return;
    }
    if (method === 'POST' && path === '/admin/resume') {
      if (!can(principal, 'system:write')) { send(res, 403, { error: '当前角色无此权限' }); return; }
      if (existsSync(deps.cfg.killSwitchFile)) rmSync(deps.cfg.killSwitchFile); send(res, 200, { paused: false }); return;
    }
    send(res, 404, { error: 'not found' });
    return;
  }

  // 执行器令牌只用于执行器通道（已在上面处理）；它到不了业务面（/run、/jobs、/kb）。
  if (principal.kind === 'executor') { send(res, 403, { error: '执行器令牌只能用于执行器通道 /executor/*' }); return; }

  if (method === 'POST' && path === '/run') { await deps.handleRun(req, res, principal); return; }
  if (method === 'POST' && path === '/send') { await deps.handleSend(req, res, principal); return; }
  if (method === 'POST' && path === '/kb/search') {
    // 检索与 /run 共用接入方限速桶（embedding 调用花的是真钱）。
    if (principal.kind === 'client' && await rateLimitedFor(deps.configStore, principal.client)) {
      send(res, 429, { error: `超出限速（${principal.client.rate_limit_per_min}/分钟）` }); return;
    }
    await deps.handleKbSearchFor(kbApiDeps(deps), req, res); return;
  }
  // 知识库入库插座：PUT/DELETE 按外部源幂等键推/删文档，GET 对账清单。
  const mKbDoc = (method === 'PUT' || method === 'DELETE') ? path.match(/^\/kb\/([a-z0-9][a-z0-9_-]{1,63})\/docs\/([A-Za-z0-9_.:-]{1,128})$/) : null;
  if (mKbDoc) { await deps.handleKbIngestFor(kbApiDeps(deps), req, res, principal, method, mKbDoc[1]!, mKbDoc[2]!); return; }
  const mKbList = method === 'GET' ? path.match(/^\/kb\/([a-z0-9][a-z0-9_-]{1,63})\/docs$/) : null;
  if (mKbList) { await deps.handleKbIngestListFor(kbApiDeps(deps), res, principal, mKbList[1]!); return; }
  if (method === 'GET' && path.startsWith('/jobs/')) {
    const job = await deps.stateStore.getJob(path.slice('/jobs/'.length));
    // 接入方只能看自己触发的 job（job_id 是 uuid 不可猜，这里是第二道闸）。
    if (!job || (!isAdmin && job.client_app_id !== principal.client.app_id)) { send(res, 404, { error: 'not found' }); return; }
    send(res, 200, job);
    return;
  }
  send(res, 404, { error: 'not found' });
}
