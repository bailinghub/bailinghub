// 后台知识库 API：知识库、文档、拉取式数据源、同步和命中测试。
// 运行时知识注入在 knowledge-runtime；这里仅承接控制台管理面。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, readBody, send } from '../app/http';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { KbService } from '../services/kb';
import type { KbSyncService } from '../services/kbsync';

export interface AdminKbApiDeps {
  kbService: KbService | null;
  kbSync: KbSyncService | null;
  stateStore: RuntimeStateStore;
  now: () => string;
}

export async function handleAdminKbApiFor(
  deps: AdminKbApiDeps,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!deps.kbService || !(path === '/admin/api/kb' || path.startsWith('/admin/api/kb/'))) return false;
  const knowledge = deps.kbService;
  const sync = deps.kbSync;

  if (path === '/admin/api/kb') {
    if (method === 'GET') { send(res, 200, await knowledge.listBases()); return true; }
    if (method === 'POST') {
      const b = (await readBody(req)) as Record<string, unknown>;
      const kbId = String(b['kb_id'] ?? '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(kbId)) { send(res, 400, { error: 'kb_id 仅限小写字母/数字/中划线/下划线' }); return true; }
      if (!b['name'] || !b['credential']) { send(res, 400, { error: 'name / credential 必填' }); return true; }
      try {
        await knowledge.upsertBase({
          kb_id: kbId, name: String(b['name']), credential: String(b['credential']).trim(),
          model: String(b['model'] ?? '').trim() || 'text-embedding-v4',
          dim: Number(b['dim'] ?? 1024) || 1024,
          enabled: b['enabled'] !== false, description: b['description'] ? String(b['description']) : undefined,
          writers: Array.isArray(b['writers']) ? (b['writers'] as unknown[]).map(String).filter(Boolean) : [],
        });
      } catch (e) { send(res, 400, { error: errMsg(e) }); return true; }
      send(res, 200, { ok: true });
      return true;
    }
  }

  const mDocs = path.match(/^\/admin\/api\/kb\/([^/]+)\/docs$/);
  if (mDocs) {
    const kbId = decodeURIComponent(mDocs[1]!);
    if (method === 'GET') { send(res, 200, await knowledge.listDocs(kbId)); return true; }
    if (method === 'POST') {
      const b = (await readBody(req)) as Record<string, unknown>;
      const title = String(b['title'] ?? '').trim();
      const content = String(b['content'] ?? '').trim();
      if (!title || !content) { send(res, 400, { error: 'title / content 必填' }); return true; }
      if (content.length > 500_000) { send(res, 400, { error: '单篇文档上限 50 万字符，请拆分' }); return true; }
      try {
        const docId = await knowledge.addDoc(kbId, title.slice(0, 191), content);
        send(res, 200, { ok: true, doc_id: docId, status: 'embedding' });
      } catch (e) { send(res, 400, { error: errMsg(e) }); }
      return true;
    }
  }

  const mDoc = path.match(/^\/admin\/api\/kb\/([^/]+)\/docs\/(\d+)$/);
  if (mDoc && method === 'DELETE') {
    await knowledge.deleteDoc(decodeURIComponent(mDoc[1]!), Number(mDoc[2]));
    send(res, 200, { ok: true });
    return true;
  }

  // ---- 数据源连接器（拉取式入库）----
  if (sync) {
    const mDsList = path.match(/^\/admin\/api\/kb\/([^/]+)\/datasources$/);
    if (mDsList) {
      const kbId = decodeURIComponent(mDsList[1]!);
      if (!(await knowledge.getBase(kbId))) { send(res, 404, { error: `未知知识库: ${kbId}` }); return true; }
      if (method === 'GET') { send(res, 200, await sync.list(kbId)); return true; }
      if (method === 'POST') {
        const b = (await readBody(req)) as Record<string, unknown>;
        for (const f of ['name', 'db_host', 'db_user', 'db_database', 'query_sql', 'key_field', 'title_field', 'content_template']) {
          if (!String(b[f] ?? '').trim()) { send(res, 400, { error: `${f} 必填` }); return true; }
        }
        try {
          const dsId = await sync.upsert({
            ds_id: b['ds_id'] ? Number(b['ds_id']) : undefined, kb_id: kbId,
            name: String(b['name']).trim(), db_host: String(b['db_host']).trim(),
            db_port: Number(b['db_port'] ?? 3306) || 3306, db_user: String(b['db_user']).trim(),
            db_password: String(b['db_password'] ?? ''), db_database: String(b['db_database']).trim(),
            query_sql: String(b['query_sql']).trim(), key_field: String(b['key_field']).trim(),
            title_field: String(b['title_field']).trim(), content_template: String(b['content_template']),
            interval_min: Math.max(Number(b['interval_min'] ?? 60) || 0, 0), enabled: b['enabled'] !== false,
          });
          send(res, 200, { ok: true, ds_id: dsId });
        } catch (e) { send(res, 400, { error: errMsg(e) }); }
        return true;
      }
    }

    const mDsTest = path.match(/^\/admin\/api\/kb\/([^/]+)\/datasources\/test$/);
    if (mDsTest && method === 'POST') {
      const b = (await readBody(req)) as Record<string, unknown>;
      try {
        // 编辑态密码留空 = 用库里存的那份测
        let password = String(b['db_password'] ?? '');
        if (!password && b['ds_id']) password = (await sync.get(Number(b['ds_id'])))?.db_password ?? '';
        const preview = await sync.preview({
          db_host: String(b['db_host'] ?? '').trim(), db_port: Number(b['db_port'] ?? 3306) || 3306,
          db_user: String(b['db_user'] ?? '').trim(), db_password: password, db_database: String(b['db_database'] ?? '').trim(),
          query_sql: String(b['query_sql'] ?? ''), key_field: String(b['key_field'] ?? '').trim(),
          title_field: String(b['title_field'] ?? '').trim(), content_template: String(b['content_template'] ?? ''),
        });
        send(res, 200, { ok: true, preview });
      } catch (e) { send(res, 400, { error: errMsg(e) }); }
      return true;
    }

    const mDsSync = path.match(/^\/admin\/api\/kb\/([^/]+)\/datasources\/(\d+)\/sync$/);
    if (mDsSync && method === 'POST') {
      const dsId = Number(mDsSync[2]);
      // 异步跑：首轮全量可能要嵌几百篇，不让 admin 请求挂着等；进度看列表 last_status/last_stats
      void sync.sync(dsId, 'manual')
        .then((stats) => deps.stateStore.appendAudit({ ts: deps.now(), job_id: '-', request_id: 'kb-ds', event: 'kb_ds_sync', detail: { ds_id: dsId, trigger: 'manual', ...stats } }))
        .catch((e) => deps.stateStore.appendAudit({ ts: deps.now(), job_id: '-', request_id: 'kb-ds', event: 'kb_ds_sync_error', detail: { ds_id: dsId, trigger: 'manual', error: errMsg(e) } }))
        .catch(() => undefined);
      send(res, 200, { ok: true, started: true });
      return true;
    }

    const mDs = path.match(/^\/admin\/api\/kb\/([^/]+)\/datasources\/(\d+)$/);
    if (mDs && method === 'DELETE') {
      const purged = await sync.remove(Number(mDs[2]));
      send(res, 200, { ok: true, purged_docs: purged });
      return true;
    }
  }

  const mHit = path.match(/^\/admin\/api\/kb\/([^/]+)\/hittest$/);
  if (mHit && method === 'POST') {
    const b = (await readBody(req)) as Record<string, unknown>;
    const query = String(b['query'] ?? '').trim();
    if (!query) { send(res, 400, { error: 'query 必填' }); return true; }
    try {
      // 命中测试不设 min_score：把低分也亮出来，方便后台判断阈值该设多少
      const hits = await knowledge.search(decodeURIComponent(mHit[1]!), query.slice(0, 2000), Number(b['top_k'] ?? 5) || 5, -1);
      send(res, 200, { hits });
    } catch (e) { send(res, 400, { error: errMsg(e) }); }
    return true;
  }

  const mKb = path.match(/^\/admin\/api\/kb\/([^/]+)$/);
  if (mKb && method === 'DELETE') {
    await knowledge.deleteBase(decodeURIComponent(mKb[1]!));
    send(res, 200, { ok: true });
    return true;
  }

  return false;
}
