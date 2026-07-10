// 后台接入与执行器令牌 API：业务接入方、执行器接入令牌和密钥 reveal 审计。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { can, type Principal } from '../app/auth';
import { prepareClientConfig, prepareExecutorTokenConfig } from '../core/config/config-models';
import { readBody, send } from '../app/http';
import type { Client, ExecutorToken } from '../core/contracts/types';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { maskKey } from './admin-format';

export interface AdminAccessApiDeps {
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  now: () => string;
}

export async function handleAdminAccessApiFor(
  deps: AdminAccessApiDeps,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  principal: Principal,
): Promise<boolean> {
  if (!deps.configStore) return false;
  const configStore = deps.configStore;

  // ---- 执行器接入令牌（claim/result 专用鉴权，替代共享管理员 token）。token 列表掩码、显式 reveal、留痕 ----
  if (path === '/admin/api/executor-tokens') {
    if (method === 'GET') {
      send(res, 200, (await configStore.executorTokens.list()).map((t) => ({ ...t, token: maskKey(t.token) })));
      return true;
    }
    if (method === 'POST') {
      const b = (await readBody(req)) as Partial<ExecutorToken> & { rotate_token?: boolean };
      const prepared = prepareExecutorTokenConfig(b);
      if (!prepared.ok) { send(res, 400, { error: prepared.error }); return true; }
      const token = await configStore.executorTokens.upsert(prepared.value, b.rotate_token === true);
      send(res, 200, { ok: true, name: prepared.value.name, token });
      return true;
    }
  }

  // 取完整令牌：列表只给掩码，挂执行器需要完整值——显式取回（需 runs:write）+ 留痕
  const mEtToken = path.match(/^\/admin\/api\/executor-tokens\/([a-z0-9][a-z0-9_-]{1,63})\/token$/);
  if (mEtToken && method === 'GET') {
    if (!can(principal, 'runs:write')) { send(res, 403, { error: '查看完整令牌需要执行器管理权限' }); return true; }
    const t = await configStore.executorTokens.get(mEtToken[1]!);
    if (!t) { send(res, 404, { error: '令牌不存在' }); return true; }
    await deps.stateStore.appendAudit({ ts: deps.now(), job_id: '-', request_id: 'config', event: 'executor_token_revealed', detail: { name: t.name, by: principal.kind === 'admin' ? principal.username ?? 'token' : '?' } }).catch(() => undefined);
    send(res, 200, { name: t.name, token: t.token });
    return true;
  }
  if (path.startsWith('/admin/api/executor-tokens/') && method === 'DELETE') {
    await configStore.executorTokens.delete(decodeURIComponent(path.slice('/admin/api/executor-tokens/'.length)));
    send(res, 200, { ok: true });
    return true;
  }

  if (path === '/admin/api/clients') {
    // token 即调用方凭证，与工具源 secret / 凭证 api_key 同等对待：列表只给掩码，完整值走显式 reveal（见下）
    if (method === 'GET') {
      send(res, 200, (await configStore.clients.list()).map((c) => ({ ...c, token: maskKey(c.token) })));
      return true;
    }
    if (method === 'POST') {
      const b = (await readBody(req)) as Partial<Client> & { rotate_token?: boolean };
      const prepared = prepareClientConfig(b);
      if (!prepared.ok) { send(res, 400, { error: prepared.error }); return true; }
      const token = await configStore.clients.upsert(prepared.value, b.rotate_token === true);
      send(res, 200, { ok: true, app_id: prepared.value.app_id, token });
      return true;
    }
  }
  if (path.startsWith('/admin/api/clients/') && method === 'DELETE') {
    await configStore.clients.delete(decodeURIComponent(path.slice('/admin/api/clients/'.length)));
    send(res, 200, { ok: true });
    return true;
  }

  // 取完整 token：列表只给掩码，业务侧接入需要完整值配 Authorization——故提供显式取回（需 clients:write，
  // 与改配置同权限）+ 审计留痕。与工具源 secret 的 /secret 端点同一模式（密钥类资源统一：列表掩码、显式 reveal、留痕）。
  const mClientToken = path.match(/^\/admin\/api\/clients\/([a-z0-9][a-z0-9_-]{1,63})\/token$/);
  if (mClientToken && method === 'GET') {
    if (!can(principal, 'clients:write')) { send(res, 403, { error: '查看完整 token 需要接入方管理权限' }); return true; }
    const c = await configStore.clients.get(mClientToken[1]!);
    if (!c) { send(res, 404, { error: '接入方不存在' }); return true; }
    await deps.stateStore.appendAudit({ ts: deps.now(), job_id: '-', request_id: 'config', event: 'client_token_revealed', detail: { app_id: c.app_id, by: principal.kind === 'admin' ? principal.username ?? 'token' : 'client' } }).catch(() => undefined);
    send(res, 200, { app_id: c.app_id, token: c.token });
    return true;
  }

  return false;
}
