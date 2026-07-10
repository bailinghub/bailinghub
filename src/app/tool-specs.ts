import { createHash } from 'node:crypto';
import { errMsg } from './http';
import { outboundRuntimeDepsFor, sendAlertWithDeps } from './outbound';
import { compileOpenApiTools, parseOpenApiSpec } from '../core/contracts/openapi-tools';
import type { ToolDefinition } from '../core/contracts/tool-definition';
import { signToolCall } from '../core/contracts/tools';
import type { ToolProvider } from '../core/contracts/types';
import { embedConfigOf } from './tool-context';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ToolIndexService } from '../services/tools-index';
import type { AppConfig } from '../core/config/config';

function specToolFingerprints(specJson: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!specJson) return m;
  for (const t of compileOpenApiTools(specJson).tools) {
    const confirmWhen = t.confirmWhen?.length ? ` confirm_when=${JSON.stringify(t.confirmWhen)}` : '';
    m.set(t.name, `${t.method} ${t.path} scope=${t.scope} risk=${t.risk}${t.confirmRequired ? ' confirm' : ''}${confirmWhen}${t.requiresSubject ? ' subj' : ''}${t.sensitive ? ' sens' : ''}${t.readonly && t.method !== 'GET' ? ' ro' : ''}`);
  }
  return m;
}

/** 拉取并应用工具源 spec（手动刷新与定时器共用）。 */
export async function refreshProviderSpecFor(
  config: ConfigStoreContract | null,
  state: RuntimeStateStore,
  index: ToolIndexService | null,
  p: ToolProvider,
  via: 'manual' | 'auto',
  appConfig: AppConfig,
  nowFn: () => string,
  sleepFn: (ms: number) => Promise<void>,
): Promise<{ tools: number; added: string[]; removed: string[]; changed: string[] }> {
  if (!config) throw new Error('configstore 不可用');
  const outboundRuntime = outboundRuntimeDepsFor({ cfg: appConfig, configStore: config, stateStore: state, now: nowFn, sleep: sleepFn });
  if (p.spec_source !== 'url' || !p.spec_url) throw new Error('该工具源是 inline 模式，直接在编辑里粘贴新 spec');
  const u = new URL(p.spec_url);
  const ts = Math.floor(Date.now() / 1000);
  const sig = signToolCall(p.secret, ts, 'GET', u.pathname + u.search, '');
  const r = await fetch(p.spec_url, {
    headers: { 'x-bailing-timestamp': String(ts), 'x-bailing-signature': sig },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`拉取 spec 失败：HTTP ${r.status}`);
  const text = await r.text();
  const parsed = parseOpenApiSpec(text);
  if (!parsed.ok) throw new Error(parsed.error);
  const specJson = parsed.canonicalJson;
  const after = specToolFingerprints(specJson);
  if (specJson === p.spec_json) {
    await config.toolProviders.upsert({ ...p, spec_refreshed_at: new Date().toISOString() });
    return { tools: after.size, added: [], removed: [], changed: [] };
  }
  const before = specToolFingerprints(p.spec_json);
  const added: string[] = []; const removed: string[] = []; const changed: string[] = [];
  for (const [name, fp] of after) {
    if (!before.has(name)) added.push(`${name}（${fp}）`);
    else if (before.get(name) !== fp) changed.push(`${name}：${before.get(name)} → ${fp}`);
  }
  for (const name of before.keys()) if (!after.has(name)) removed.push(name);
  await config.toolProviders.upsert({ ...p, spec_json: specJson, spec_refreshed_at: new Date().toISOString() });
  await state.appendAudit({
    ts: nowFn(), job_id: '-', request_id: 'tools', event: 'spec_refreshed',
    detail: { provider: p.name, via, tools: after.size, added, removed, changed },
  }).catch(() => undefined);
  if (added.length || removed.length || changed.length) {
    const lines = [
      `工具源 ${p.name} 的接口清单发生变更（${via === 'auto' ? '自动刷新' : '手动刷新'}）：`,
      ...added.map((s) => `新增 ${s}`), ...removed.map((s) => `移除 ${s}`), ...changed.map((s) => `变更 ${s}`),
      '若变更非预期，请到控制台「工具源」停用该源或收紧路由白名单。',
    ].join('\n');
    const fpHash = createHash('sha256').update(lines).digest('hex').slice(0, 8);
    void sendAlertWithDeps(outboundRuntime, `spec_change_${p.name}_${fpHash}`, lines);
  }
  await reindexToolProviderIndexFor(state, index, { ...p, spec_json: specJson }, nowFn).catch(async (e) => {
    await state.appendAudit({ ts: nowFn(), job_id: '-', request_id: 'tools', event: 'tool_index_failed', detail: { provider: p.name, error: String(e).slice(0, 200) } }).catch(() => undefined);
  });
  return { tools: after.size, added, removed, changed };
}

export async function reindexToolProviderIndexFor(state: RuntimeStateStore, index: ToolIndexService | null, p: ToolProvider, nowFn: () => string): Promise<{ added: string[]; changed: string[]; removed: string[]; unchanged: number; total: number } | null> {
  const ec = embedConfigOf(p);
  if (!index || !ec) return null;
  const ir = await index.reindexProvider(p, ec);
  await state.appendAudit({ ts: nowFn(), job_id: '-', request_id: 'tools', event: 'tool_index_updated', detail: { provider: p.name, ...ir } }).catch(() => undefined);
  return ir;
}

export async function retrievalProbeFor(index: ToolIndexService | null, p: ToolProvider, query: string, k = 30): Promise<{ enabled: boolean; min_score_default: number; hits: Array<{ name: string; scope: string; score: number }> }> {
  const ec = embedConfigOf(p);
  if (!index || !ec) return { enabled: false, min_score_default: 0.3, hits: [] };
  if (!p.spec_json) return { enabled: true, min_score_default: 0.3, hits: [] };
  const allNames = new Set(compileOpenApiTools(p.spec_json).tools.map((t) => t.name));
  const hits = await index.retrieve(p.name, allNames, query, ec, { minScore: 0, maxTools: Math.min(Math.max(k, 1), 40) });
  return { enabled: true, min_score_default: 0.3, hits: hits ?? [] };
}

const PROBE_SUBJECT = '__bailing_authz_probe__:nobody';

export interface AuthzProbeResult {
  status: 'pass' | 'suspect' | 'inconclusive' | 'skipped';
  http?: number;
  tool?: string;
  mode?: 'dedicated' | 'tool';
  requires_subject?: boolean;
  reason?: string;
  at: string;
}

const lastProbe = new Map<string, AuthzProbeResult>();
export function getAuthzProbe(name: string): AuthzProbeResult | undefined { return lastProbe.get(name); }

function pickProbeTarget(tools: ToolDefinition[]): ToolDefinition | undefined {
  const hasRequired = (t: ToolDefinition): boolean => { const r = t.inputSchema['required']; return Array.isArray(r) && r.length > 0; };
  const noParamGets = tools.filter((t) => t.method === 'GET' && !hasRequired(t));
  return noParamGets.find((t) => t.requiresSubject) ?? noParamGets[0];
}

export interface DedicatedAuthzProbeTarget {
  method: 'GET' | 'POST';
  path: string;
  name: string;
}

function normalizeProbeMethod(v: unknown): 'GET' | 'POST' {
  return String(v ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
}

function isPath(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('/') && v.length <= 512;
}

export function dedicatedAuthzProbeTarget(specJson: string | undefined): DedicatedAuthzProbeTarget | null {
  if (!specJson) return null;
  const parsed = parseOpenApiSpec(specJson);
  if (!parsed.ok) return null;
  const spec: any = parsed.spec;
  const root = spec?.['x-bailing-authz-probe'];
  if (root && typeof root === 'object' && isPath(root.path)) {
    return { method: normalizeProbeMethod(root.method), path: root.path, name: String(root.operationId || 'authz_probe').slice(0, 64) };
  }
  for (const [path, ops] of Object.entries<any>(spec?.paths ?? {})) {
    if (!isPath(path) || !ops || typeof ops !== 'object') continue;
    for (const [method, op] of Object.entries<any>(ops)) {
      if (!op || typeof op !== 'object') continue;
      if (op['x-bailing-authz-probe'] === true) {
        const m = normalizeProbeMethod(method);
        return { method: m, path, name: String(op.operationId || `${method}_${path}`.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'authz_probe').slice(0, 64) };
      }
    }
  }
  return null;
}

function booleanDecision(text: string): boolean | null {
  if (!text.trim()) return null;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    for (const key of ['authorized', 'allow', 'allowed', 'ok']) {
      if (typeof body[key] === 'boolean') return body[key] as boolean;
    }
  } catch { /* ignore non-json */ }
  return null;
}

export function classifyDedicatedAuthzProbe(http: number, text: string, tool: string): Omit<AuthzProbeResult, 'at'> {
  const base = { mode: 'dedicated' as const, tool, requires_subject: true };
  if (http === 401 || http === 403) return { status: 'pass', http, ...base, reason: '专用探针端点拒绝合成越权主体' };
  if (http >= 200 && http < 300) {
    const decision = booleanDecision(text);
    if (decision === false) return { status: 'pass', http, ...base, reason: '专用探针端点返回 authorized=false' };
    if (decision === true) return { status: 'suspect', http, ...base, reason: '专用探针端点对合成越权主体返回 authorized=true' };
    return { status: 'inconclusive', http, ...base, reason: '专用探针端点 2xx 但未返回 authorized/allow/allowed/ok 布尔结论' };
  }
  return { status: 'inconclusive', http, ...base, reason: `专用探针端点返回 HTTP ${http}，无法判定` };
}

function joinBaseAndPath(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

export async function probeAuthorizeFor(
  config: ConfigStoreContract | null,
  state: RuntimeStateStore,
  p: ToolProvider,
  appConfig: AppConfig,
  nowFn: () => string,
  sleepFn: (ms: number) => Promise<void>,
): Promise<AuthzProbeResult> {
  const outboundRuntime = outboundRuntimeDepsFor({ cfg: appConfig, configStore: config, stateStore: state, now: nowFn, sleep: sleepFn });
  const at = new Date().toISOString();
  const done = (r: Omit<AuthzProbeResult, 'at'>): AuthzProbeResult => {
    const full = { ...r, at }; lastProbe.set(p.name, full); return full;
  };
  const finish = async (result: Omit<AuthzProbeResult, 'at'>): Promise<AuthzProbeResult> => {
    const r = done(result);
    await state.appendAudit({ ts: nowFn(), job_id: '-', request_id: `authz_probe:${p.name}`, event: 'authorize_probe', detail: { provider: p.name, ...r } }).catch(() => undefined);
    await config?.toolProviders.updateAuthzProbe(p.name, r).catch(() => undefined);
    if (r.status === 'suspect') {
      void sendAlertWithDeps(outboundRuntime, `authz_probe_${p.name}`, `工具源「${p.name}」authorize 探针疑似「只验签未授权」：工具 ${r.tool} 声明了 ACC subject.required，却对合成越权主体返回 HTTP ${r.http}。请确认业务侧已把 On-Behalf-Of 接进权限表并 fail-closed（authorize 切勿 return true）。`);
    }
    return r;
  };
  if (!p.enabled) return finish({ status: 'skipped', reason: '工具源已停用' });
  if (!p.base_url || !p.secret) return finish({ status: 'skipped', reason: '缺 base_url 或 secret' });
  if (!p.spec_json) return finish({ status: 'skipped', reason: '无 spec' });
  const dedicated = dedicatedAuthzProbeTarget(p.spec_json);
  if (dedicated) {
    const body = dedicated.method === 'POST'
      ? JSON.stringify({ subject: PROBE_SUBJECT, reason: 'bailing-authz-probe', expect: 'deny' })
      : '';
    const ts = Math.floor(Date.now() / 1000);
    const sig = signToolCall(p.secret, ts, dedicated.method, dedicated.path, body, PROBE_SUBJECT, 'probe');
    let http = 0; let text = ''; let netErr = '';
    try {
      const r = await fetch(joinBaseAndPath(p.base_url, dedicated.path), {
        method: dedicated.method,
        headers: {
          'content-type': 'application/json',
          'x-bailing-timestamp': String(ts), 'x-bailing-signature': sig, 'x-bailing-job-id': 'probe',
          'x-bailing-client': '__probe__', 'x-bailing-on-behalf-of': PROBE_SUBJECT, 'x-bailing-tool-scope': '__probe__.authz',
        },
        body: dedicated.method === 'POST' ? body : undefined,
        signal: AbortSignal.timeout(Math.min(p.timeout_ms || 8000, 8000)),
      });
      http = r.status; text = await r.text().catch(() => '');
    } catch (e) { netErr = e instanceof Error && e.name === 'TimeoutError' ? '超时' : errMsg(e); }
    if (netErr) return finish({ status: 'inconclusive', mode: 'dedicated', tool: dedicated.name, requires_subject: true, reason: `专用探针请求失败：${netErr}` });
    return finish(classifyDedicatedAuthzProbe(http, text, dedicated.name));
  }
  const target = pickProbeTarget(compileOpenApiTools(p.spec_json).tools);
  if (!target) return finish({ status: 'skipped', reason: '无适合探针的无参 GET 工具（不猜参数、不碰写接口）' });

  const ts = Math.floor(Date.now() / 1000);
  const sig = signToolCall(p.secret, ts, 'GET', target.path, '', PROBE_SUBJECT, 'probe');
  let http = 0; let netErr = '';
  try {
    const r = await fetch(p.base_url.replace(/\/+$/, '') + target.path, {
      method: 'GET',
      headers: {
        'x-bailing-timestamp': String(ts), 'x-bailing-signature': sig, 'x-bailing-job-id': 'probe',
        'x-bailing-client': '__probe__', 'x-bailing-on-behalf-of': PROBE_SUBJECT, 'x-bailing-tool-scope': target.scope,
      },
      signal: AbortSignal.timeout(Math.min(p.timeout_ms || 8000, 8000)),
    });
    http = r.status;
    await r.text().catch(() => '');
  } catch (e) { netErr = e instanceof Error && e.name === 'TimeoutError' ? '超时' : errMsg(e); }

  const base = { tool: target.name, mode: 'tool' as const, requires_subject: target.requiresSubject };
  let r: AuthzProbeResult;
  if (netErr) r = await finish({ status: 'inconclusive', ...base, reason: `探针请求失败：${netErr}` });
  else if (http === 401 || http === 403) r = await finish({ status: 'pass', http, ...base });
  else if (http >= 200 && http < 300) {
    r = target.requiresSubject
      ? await finish({ status: 'suspect', http, ...base, reason: '该工具声明 ACC subject.required，却对合成越权主体返回 2xx——疑似只验签未授权' })
      : await finish({ status: 'inconclusive', http, ...base, reason: '该 GET 未声明 requires-subject，2xx 无法区分合法公开读 / 未授权' });
  } else r = await finish({ status: 'inconclusive', http, ...base, reason: `既非 4xx 拒绝也非 2xx（HTTP ${http}），无法判定` });
  return r;
}

const specRefreshAttemptAt = new Map<string, number>();
export async function runSpecAutoRefreshFor(
  config: ConfigStoreContract | null,
  state: RuntimeStateStore,
  index: ToolIndexService | null,
  appConfig: AppConfig,
  nowFn: () => string,
  sleepFn: (ms: number) => Promise<void>,
): Promise<void> {
  if (!config) return;
  const outboundRuntime = outboundRuntimeDepsFor({ cfg: appConfig, configStore: config, stateStore: state, now: nowFn, sleep: sleepFn });
  const providers = await config.toolProviders.list().catch(() => [] as ToolProvider[]);
  for (const p of providers) {
    if (!p.enabled || p.spec_source !== 'url' || !p.spec_url || p.auto_refresh_min <= 0) continue;
    const last = specRefreshAttemptAt.get(p.name) ?? 0;
    if (Date.now() - last < p.auto_refresh_min * 60_000) continue;
    specRefreshAttemptAt.set(p.name, Date.now());
    try {
      await refreshProviderSpecFor(config, state, index, p, 'auto', appConfig, nowFn, sleepFn);
      const fresh = await config.toolProviders.get(p.name);
      if (fresh) await probeAuthorizeFor(config, state, fresh, appConfig, nowFn, sleepFn).catch(() => undefined);
    }
    catch (e) {
      await state.appendAudit({
        ts: nowFn(), job_id: '-', request_id: 'tools', event: 'spec_refresh_failed',
        detail: { provider: p.name, error: String(e).slice(0, 200) },
      }).catch(() => undefined);
      void sendAlertWithDeps(outboundRuntime, `spec_refresh_fail_${p.name}`, `工具源 ${p.name} 自动刷新 spec 失败：${errMsg(e)}（spec_url: ${p.spec_url}）。AI 仍按旧清单工作，请检查业务侧发布地址。`);
    }
  }
}
