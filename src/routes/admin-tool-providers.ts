// 后台工具源 API：业务系统 OpenAPI/ToolDefinition 的注册、对账、索引和调试入口。
// 这里是“AI 调业务工具”这条核心卖点的控制台边界，不放在通用 admin 分发器里。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { can, type Principal } from '../app/auth';
import { compileOpenApiTools } from '../core/contracts/openapi-tools';
import { skippedDiagnostics, warningDiagnostics } from '../core/contracts/tool-definition';
import { getAuthzProbe, probeAuthorizeFor, refreshProviderSpecFor, reindexToolProviderIndexFor, retrievalProbeFor } from '../app/tools-runtime';
import { debugInvokeTool } from '../app/tool-debug';
import { prepareToolProviderConfig } from '../core/config/config-models';
import { errMsg, readBody, send } from '../app/http';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { ToolIndexService } from '../services/tools-index';
import type { AppConfig } from '../core/config/config';
import { maskKey } from './admin-format';

export interface AdminToolProviderApiDeps {
  cfg: AppConfig;
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  toolIndex: ToolIndexService | null;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
}

export async function handleAdminToolProviderApiFor(
  deps: AdminToolProviderApiDeps,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  principal: Principal,
): Promise<boolean> {
  if (!deps.configStore) return false;
  const configStore = deps.configStore;

  // ---- 工具源（鉴权执行层：业务系统的 AI 可调接口清单；secret 入库不回显）----
  if (path === '/admin/api/tool-providers') {
    if (method === 'GET') {
      const list = await configStore.toolProviders.list();
      send(res, 200, list.map((p) => ({ ...p, secret: maskKey(p.secret), spec_json: undefined, has_spec: !!p.spec_json, authz_probe: p.authz_probe ?? getAuthzProbe(p.name) })));
      return true;
    }
    if (method === 'POST') {
      const b = (await readBody(req)) as Record<string, unknown>;
      const old = await configStore.toolProviders.get(String(b['name'] ?? '').trim());
      const prepared = prepareToolProviderConfig(b, old);
      if (!prepared.ok) { send(res, 400, { error: prepared.error }); return true; }
      const prov = prepared.value;
      await configStore.toolProviders.upsert(prov);
      // 注册期 authorize 探针（只读、不阻断；得 suspect = 疑似只验签未授权，控制台据 authz_probe 标红）
      const authz_probe = await probeAuthorizeFor(configStore, deps.stateStore, prov, deps.cfg, deps.now, deps.sleep).catch(() => undefined);
      // 配齐了 embedding 坐标系且有 spec → 顺手建/增量重建工具检索索引（失败不阻塞保存，控制台用 index_result 提示）
      let index_result: unknown;
      if (prov.embed_credential && prov.embed_model && prov.embed_dim && prov.spec_json) {
        index_result = await reindexToolProviderIndexFor(deps.stateStore, deps.toolIndex, prov, deps.now).catch((e) => ({ error: errMsg(e) }));
      }
      send(res, 200, { ok: true, authz_probe, index_result });
      return true;
    }
  }

  // 手动授权探针：只读、不改业务数据；用于验证业务侧是否真的按 On-Behalf-Of 做 fail-closed 授权。
  const mProvProbe = path.match(/^\/admin\/api\/tool-providers\/([a-z0-9_-]+)\/authz-probe$/);
  if (mProvProbe && method === 'POST') {
    const p = await configStore.toolProviders.get(mProvProbe[1]!);
    if (!p) { send(res, 404, { error: '工具源不存在' }); return true; }
    const authz_probe = await probeAuthorizeFor(configStore, deps.stateStore, p, deps.cfg, deps.now, deps.sleep);
    send(res, 200, { ok: true, authz_probe });
    return true;
  }

  // 取完整签名密钥：列表只给掩码，业务侧验签需要完整值——这把密钥的用途本就是交给业务方（共享密钥，非中枢私有），
  // 故提供显式取回（需 tools:write，与改配置同权限）。注意：与模型凭证的 api_key 不同（那是中枢出站凭证、永不外泄）。
  const mProvSecret = path.match(/^\/admin\/api\/tool-providers\/([a-z0-9_-]+)\/secret$/);
  if (mProvSecret && method === 'GET') {
    if (!can(principal, 'tools:write')) { send(res, 403, { error: '查看完整密钥需要工具源管理权限' }); return true; }
    const p = await configStore.toolProviders.get(mProvSecret[1]!);
    if (!p) { send(res, 404, { error: '工具源不存在' }); return true; }
    await deps.stateStore.appendAudit({ ts: deps.now(), job_id: '-', request_id: 'config', event: 'tool_secret_revealed', detail: { provider: p.name, by: principal.kind === 'admin' ? principal.username ?? 'token' : 'client' } }).catch(() => undefined);
    send(res, 200, { name: p.name, secret: p.secret });
    return true;
  }

  // 刷新 spec（spec_source=url 时从 spec_url 签名拉取并缓存；与定时自动刷新共用对账逻辑）
  const mProvRefresh = path.match(/^\/admin\/api\/tool-providers\/([a-z0-9_-]+)\/refresh$/);
  if (mProvRefresh && method === 'POST') {
    const p = await configStore.toolProviders.get(mProvRefresh[1]!);
    if (!p) { send(res, 404, { error: '工具源不存在' }); return true; }
    try {
      const r = await refreshProviderSpecFor(configStore, deps.stateStore, deps.toolIndex, p, 'manual', deps.cfg, deps.now, deps.sleep);
      const fresh = await configStore.toolProviders.get(mProvRefresh[1]!); // 取回带新 spec 的副本再探针
      const authz_probe = fresh ? await probeAuthorizeFor(configStore, deps.stateStore, fresh, deps.cfg, deps.now, deps.sleep).catch(() => undefined) : undefined;
      send(res, 200, { ok: true, ...r, authz_probe });
      return true;
    } catch (e) { send(res, 400, { error: `拉取/解析失败：${errMsg(e)}` }); return true; }
  }

  // 重建工具检索索引（控制台「重建索引」按钮）：增量重嵌变更的工具；未配 embedding 凭证则提示先配
  const mProvReindex = path.match(/^\/admin\/api\/tool-providers\/([a-z0-9_-]+)\/reindex$/);
  if (mProvReindex && method === 'POST') {
    const p = await configStore.toolProviders.get(mProvReindex[1]!);
    if (!p) { send(res, 404, { error: '工具源不存在' }); return true; }
    try {
      const r = await reindexToolProviderIndexFor(deps.stateStore, deps.toolIndex, p, deps.now);
      if (!r) { send(res, 400, { error: '该工具源未开启工具检索（先填 embedding 凭证/模型/维度）' }); return true; }
      send(res, 200, { ok: true, ...r });
      return true;
    } catch (e) { send(res, 400, { error: `重建索引失败：${errMsg(e)}` }); return true; }
  }

  // 召回预演（控制台「工具清单」页的语义搜索框）：跑派发同款向量检索返回工具+分数，调试"会召回哪些/精度多高"、调优工具措辞
  const mProvRetrieveTest = path.match(/^\/admin\/api\/tool-providers\/([a-z0-9_-]+)\/retrieve-test$/);
  if (mProvRetrieveTest && method === 'POST') {
    const p = await configStore.toolProviders.get(mProvRetrieveTest[1]!);
    if (!p) { send(res, 404, { error: '工具源不存在' }); return true; }
    const b = (await readBody(req)) as Record<string, unknown>;
    const q = String(b['query'] ?? '').trim();
    if (!q) { send(res, 400, { error: '请输入检索词' }); return true; }
    try {
      send(res, 200, await retrievalProbeFor(deps.toolIndex, p, q, Number(b['k']) || 30));
      return true;
    } catch (e) { send(res, 400, { error: `召回预演失败：${errMsg(e)}` }); return true; }
  }

  // 工具实调调试：走中枢同款签名材料直接打业务源站，用于验证 base_url/path/参数位置/验签/授权是否打通。
  // 默认不直接执行 high / confirm / 条件审批工具，避免调试台绕过审批车道。
  const mProvDebugInvoke = path.match(/^\/admin\/api\/tool-providers\/([a-z0-9_-]+)\/debug-invoke$/);
  if (mProvDebugInvoke && method === 'POST') {
    const p = await configStore.toolProviders.get(mProvDebugInvoke[1]!);
    if (!p) { send(res, 404, { error: '工具源不存在' }); return true; }
    if (!p.spec_json) { send(res, 400, { error: '工具源无 spec（先刷新/粘贴）' }); return true; }
    const b = (await readBody(req)) as Record<string, unknown>;
    const toolName = String(b['tool'] ?? '').trim();
    if (!toolName) { send(res, 400, { error: 'tool 必填' }); return true; }
    const { tools, diagnostics } = compileOpenApiTools(p.spec_json);
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) { send(res, 400, { error: `工具 ${toolName} 不存在或未通过编译`, diagnostics: skippedDiagnostics(diagnostics) }); return true; }
    const args = b['args'] && typeof b['args'] === 'object' && !Array.isArray(b['args']) ? b['args'] as Record<string, unknown> : {};
    const result = await debugInvokeTool({
      provider: p,
      tool,
      args,
      onBehalfOf: String(b['on_behalf_of'] ?? ''),
      jobId: String(b['job_id'] ?? ''),
      clientAppId: 'admin-debug',
      allowRisky: b['allow_risky'] === true,
    });
    await deps.stateStore.appendAudit({
      ts: deps.now(),
      job_id: '-',
      request_id: 'tool-debug',
      event: 'tool_debug_invoke',
      detail: {
        provider: p.name,
        tool: tool.name,
        status: result.response?.status ?? 0,
        ok: result.ok,
        blocked: !!result.blocked,
        by: principal.kind === 'admin' ? principal.username ?? 'token' : 'client',
      },
    }).catch(() => undefined);
    send(res, 200, result);
    return true;
  }

  // 工具清单预览：派生结果 + 被跳过的及原因（控制台「工具源」页用）
  const mProvTools = path.match(/^\/admin\/api\/tool-providers\/([a-z0-9_-]+)\/tools$/);
  if (mProvTools && method === 'GET') {
    const p = await configStore.toolProviders.get(mProvTools[1]!);
    if (!p) { send(res, 404, { error: '工具源不存在' }); return true; }
    if (!p.spec_json) { send(res, 200, { tools: [], diagnostics: [], skipped: [], warnings: [], note: '尚无 spec（粘贴或刷新）' }); return true; }
    const { tools, diagnostics } = compileOpenApiTools(p.spec_json);
    // 全量字段：工具清单是注解的"对账面"——业务侧标了什么、中枢派生成了什么，必须全部可见可核对
    send(res, 200, { tools: tools.map((t) => ({ name: t.name, source: t.source, schema_version: t.schemaVersion, method: t.method, path: t.path, scope: t.scope, risk: t.risk, confirm_required: t.confirmRequired, confirm_when: t.confirmWhen ?? [], requires_subject: t.requiresSubject, sensitive: t.sensitive, readonly: t.readonly, idempotent: t.idempotent, timeout_ms: t.timeoutMs, rate_limit_per_min: t.rateLimitPerMin, confirm_prompt: t.confirmPrompt, context: t.context, extensions: t.extensions, parameters: t.inputSchema, param_in: t.paramIn, description: t.description })), diagnostics, skipped: skippedDiagnostics(diagnostics), warnings: warningDiagnostics(diagnostics) });
    return true;
  }

  if (path.startsWith('/admin/api/tool-providers/') && method === 'DELETE') {
    await configStore.toolProviders.delete(decodeURIComponent(path.slice('/admin/api/tool-providers/'.length)));
    send(res, 200, { ok: true });
    return true;
  }

  return false;
}
