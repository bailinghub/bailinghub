// 后台聊天入口 API：网页组件入口、页面上下文寻址和聊天评价。
// 运行时聊天处理在 routes/chat.ts；这里仅承接控制台配置与运营查看。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { prepareChatEntryConfig, preparePageContextConfig } from '../core/config/config-models';
import { readBody, send } from '../app/http';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export interface AdminChatApiDeps {
  configStore: ConfigStoreContract | null;
}

export async function handleAdminChatApiFor(
  deps: AdminChatApiDeps,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!deps.configStore) return false;
  const configStore = deps.configStore;

  // ---- 聊天入口（网页组件的公开插座；entry_key 服务端生成可公开）----
  if (path === '/admin/api/chat-entries') {
    if (method === 'GET') {
      send(res, 200, await configStore.chatEntries.list());
      return true;
    }
    if (method === 'POST') {
      const b = (await readBody(req)) as Record<string, unknown>;
      const prepared = await prepareChatEntryConfig(b, {
        routeExists: async (routeKey) => !!(await configStore.routes.get(routeKey)),
        entryExists: async (entryKey) => !!(await configStore.chatEntries.get(entryKey)),
        clientExists: async (appId) => !!(await configStore.clients.get(appId)),
        bucketExists: async (name) => !!(await configStore.storageBuckets.get(name)),
      });
      if (!prepared.ok) { send(res, 400, { error: prepared.error }); return true; }
      await configStore.chatEntries.upsert(prepared.value);
      send(res, 200, { ok: true, entry_key: prepared.value.entry_key });
      return true;
    }
  }
  if (path.startsWith('/admin/api/chat-entries/') && method === 'DELETE') {
    await configStore.chatEntries.delete(decodeURIComponent(path.slice('/admin/api/chat-entries/'.length)));
    send(res, 200, { ok: true });
    return true;
  }

  // 页面登记（页面上下文寻址，scope 到聊天入口）：GET ?entry= 列表 / POST 新增改 / DELETE /:id?entry=
  if (path === '/admin/api/page-contexts') {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    if (method === 'GET') {
      const entryKey = String(q.get('entry') ?? '');
      if (!entryKey) { send(res, 400, { error: 'entry 必填' }); return true; }
      send(res, 200, await configStore.chatEntries.listPageContexts(entryKey));
      return true;
    }
    if (method === 'POST') {
      const b = (await readBody(req)) as Record<string, unknown>;
      const prepared = await preparePageContextConfig(b, { entryExists: async (entryKey) => !!(await configStore.chatEntries.get(entryKey)) });
      if (!prepared.ok) { send(res, 400, { error: prepared.error }); return true; }
      const id = await configStore.chatEntries.upsertPageContext(prepared.value);
      send(res, 200, { ok: true, id });
      return true;
    }
  }
  if (path.startsWith('/admin/api/page-contexts/') && method === 'DELETE') {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const entryKey = String(q.get('entry') ?? '');
    const id = Number(decodeURIComponent(path.slice('/admin/api/page-contexts/'.length)));
    if (!entryKey || !id) { send(res, 400, { error: 'entry 与 id 必填' }); return true; }
    await configStore.chatEntries.deletePageContext(id, entryKey);
    send(res, 200, { ok: true });
    return true;
  }

  // 聊天评价列表（运营看差评迭代知识库）
  if (path === '/admin/api/chat-ratings' && method === 'GET') {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    send(res, 200, await configStore.chatEntries.listJobRatings(q.get('entry') || undefined, Number(q.get('limit') ?? 50)));
    return true;
  }

  return false;
}
