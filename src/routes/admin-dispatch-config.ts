// 后台调度配置 API：项目、触发路由和执行目标注册表。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { prepareTargetConfig } from '../core/config/config-models';
import { readBody, send } from '../app/http';
import { prepareRouteConfig } from '../core/config/route-config';
import { getAdapter, isKnownTarget, listTargetDefs, targetNeedsProject } from '../core/targets/registry';
import type { ProjectReg, Route, TargetDef } from '../core/contracts/types';
import { resolvePrincipal } from '../core/runtime/identity-runtime';
import { previewAutoRoute } from '../core/runtime/routing-runtime';
import type { AppConfig } from '../core/config/config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export interface AdminDispatchConfigApiDeps {
  configStore: ConfigStoreContract | null;
  defaultProfile: AppConfig['defaultProfile'];
  refreshTargets: () => Promise<void>;
}

export async function handleAdminDispatchConfigApiFor(
  deps: AdminDispatchConfigApiDeps,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!deps.configStore) return false;
  const configStore = deps.configStore;

  if (path === '/admin/api/projects') {
    if (method === 'GET') { send(res, 200, await configStore.projects.list()); return true; }
    if (method === 'POST') {
      const b = (await readBody(req)) as Partial<ProjectReg>;
      if (!b.name || !b.path) { send(res, 400, { error: 'name/path 必填' }); return true; }
      await configStore.projects.upsert({ name: b.name, path: b.path, enabled: b.enabled !== false, description: b.description });
      send(res, 200, { ok: true });
      return true;
    }
  }
  if (path.startsWith('/admin/api/projects/') && method === 'DELETE') {
    await configStore.projects.delete(decodeURIComponent(path.slice('/admin/api/projects/'.length)));
    send(res, 200, { ok: true });
    return true;
  }

  if (path === '/admin/api/routes') {
    if (method === 'GET') { send(res, 200, await configStore.routes.list()); return true; }
    if (method === 'POST') {
      const b = (await readBody(req)) as Partial<Route>;
      const prepared = await prepareRouteConfig(b, {
        targetExists: isKnownTarget,
        targetNeedsProject,
        toolProviderExists: async (name) => !!(await configStore.toolProviders.get(name)),
      }, { defaultProfile: deps.defaultProfile });
      if (!prepared.ok) { send(res, 400, { error: prepared.error }); return true; }
      await configStore.routes.upsert(prepared.route);
      send(res, 200, { ok: true });
      return true;
    }
  }
  if (path.startsWith('/admin/api/routes/') && method === 'DELETE') {
    await configStore.routes.delete(decodeURIComponent(path.slice('/admin/api/routes/'.length)));
    send(res, 200, { ok: true });
    return true;
  }

  if (path === '/admin/api/routes/auto-preview' && method === 'POST') {
    const b = (await readBody(req)) as Record<string, unknown>;
    const input = String(b['input'] ?? b['text'] ?? '').trim();
    if (!input) { send(res, 400, { error: 'input 必填' }); return true; }
    const clientAppId = String(b['client_app_id'] ?? b['client_id'] ?? '').trim();
    const client = clientAppId ? await configStore.clients.get(clientAppId) : null;
    if (clientAppId && !client) { send(res, 400, { error: `接入方不存在: ${clientAppId}` }); return true; }
    const metadataRaw = b['metadata'];
    const metadata = metadataRaw && typeof metadataRaw === 'object' && !Array.isArray(metadataRaw) ? metadataRaw as Record<string, unknown> : {};
    const channel = String(b['channel'] ?? client?.app_id ?? 'admin').trim() || 'admin';
    const principalRaw = b['principal'];
    const principalMetadata = principalRaw && typeof principalRaw === 'object' && !Array.isArray(principalRaw)
      ? { ...metadata, principal: principalRaw as Record<string, unknown> }
      : metadata;
    const principal = resolvePrincipal({ metadata: principalMetadata, clientAppId: client?.app_id ?? null, channel });
    const preview = previewAutoRoute({
      routes: await configStore.routes.list(),
      text: input,
      metadata,
      client,
      principal,
      channel,
    });
    send(res, 200, {
      ...preview,
      principal,
      client: client ? { app_id: client.app_id, name: client.name, enabled: client.enabled, allowed_routes: client.allowed_routes } : null,
    });
    return true;
  }

  // ---- 调度目标注册表（插座板：新执行器=注册一行，自带执行器认领即可干活）----
  if (path === '/admin/api/targets') {
    if (method === 'GET') { send(res, 200, listTargetDefs()); return true; }
    if (method === 'POST') {
      const b = (await readBody(req)) as Partial<TargetDef>;
      const prepared = prepareTargetConfig(b, { hasInhubAdapter: (name) => !!getAdapter(name) });
      if (!prepared.ok) { send(res, 400, { error: prepared.error }); return true; }
      await configStore.targets.upsert(prepared.value);
      await deps.refreshTargets();
      send(res, 200, { ok: true });
      return true;
    }
  }
  if (path.startsWith('/admin/api/targets/') && method === 'DELETE') {
    const name = decodeURIComponent(path.slice('/admin/api/targets/'.length));
    await configStore.targets.delete(name);
    await deps.refreshTargets();
    send(res, 200, { ok: true });
    return true;
  }

  return false;
}
