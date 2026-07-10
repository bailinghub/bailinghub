import type { AppConfig } from './config';
import type { AlertRule, Channel, ChatEntry, Client, Credential, ExecutorToken, KbBase, Route, StorageBucket, TargetDef, ToolProvider } from '../contracts/types';
import { validateRouteConfig } from './route-config';
import { normalizeTargetConfig } from './target-config';
import { validateBudgetPolicy } from '../runtime/budget-runtime';
import { routeKnowledgeConfig } from './route-config';
import { sendMessageConfig, toolSourceConfigs } from './tools-config';
import { parseOpenApiSpec } from '../contracts/openapi-tools';

export type ConfigDiagnosticSeverity = 'error' | 'warning';

export interface ConfigDiagnostic {
  severity: ConfigDiagnosticSeverity;
  area: string;
  id: string;
  message: string;
}

export interface ConfigDiagnosticsReport {
  ok: boolean;
  errors: number;
  warnings: number;
  diagnostics: ConfigDiagnostic[];
}

export interface ConfigDiagnosticsStore {
  routes: { list(): Promise<Route[]>; get(key: string): Promise<Route | null> };
  clients: { list(): Promise<Client[]> };
  credentials: { list(): Promise<Credential[]> };
  channels: { list(): Promise<Channel[]> };
  toolProviders: { list(): Promise<ToolProvider[]> };
  targets: { list(): Promise<TargetDef[]> };
  projects: { list(): Promise<Array<{ name: string; enabled: boolean }>> };
  storageBuckets: { list(): Promise<StorageBucket[]> };
  alertRules: { list(): Promise<AlertRule[]> };
  chatEntries: { list(): Promise<ChatEntry[]> };
  executorTokens: { list(): Promise<ExecutorToken[]> };
  observability?: {
    dispatchStatus(): Promise<{
      summary: { queued: number; running: number; dispatched: number; delayed_queued: number; expired_leases: number; blocked_threads: number };
      by_target: Array<{ target: string; queued: number; running: number; dispatched: number }>;
    }>;
    monitorSnapshot?(): Promise<{ errors_15m: number; oldest_queued_min: number }>;
  };
  executors?: { list(): Promise<Array<{ executor_id: string; targets: string[]; last_seen_at: string }>> };
  deliveryDlq?: { list(includeResolved?: boolean, limit?: number): Promise<Array<{ id: number; parent_job_id: string; channel: string; recipient: string; error: string; resolved: boolean; created_at: string }>> };
}

export interface ConfigDiagnosticsKbService {
  listBases(): Promise<Array<KbBase & { doc_count?: number; chunk_count?: number }>>;
}

function add(out: ConfigDiagnostic[], severity: ConfigDiagnosticSeverity, area: string, id: string, message: string): void {
  out.push({ severity, area, id, message });
}

function nameOk(v: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(v);
}

function routeKeyOk(v: string): boolean {
  return /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(v);
}

function hasCredential(
  creds: Map<string, Credential>,
  fileCredentialNames: Set<string>,
  name: string,
  kinds: Array<Credential['kind']>,
): boolean {
  if (kinds.includes('chat') && fileCredentialNames.has(name)) return true;
  const c = creds.get(name);
  return !!(c && c.enabled && kinds.includes(c.kind));
}

function list(v: string[] | undefined): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

function hasAudienceFilters(route: Route): boolean {
  const a = route.audience;
  return !!(a && (
    list(a.clients).length || list(a.channels).length || list(a.tenants).length || list(a.roles).length
    || list(a.principals).length || list(a.audiences).length || a.anonymous === true
  ));
}

function routeAutoEligible(route: Route): boolean {
  return route.enabled && (route.audience?.auto === true || list(route.audience?.keywords).length > 0);
}

function clientCanReachRoute(client: Client, routeKey: string): boolean {
  const allowed = client.allowed_routes ?? [];
  return allowed.includes('*') || allowed.includes(routeKey);
}

function overlaps(a: string[], b: string[]): string[] {
  if (a.includes('*') || b.includes('*')) return ['*'];
  const bs = new Set(b);
  return a.filter((x) => bs.has(x));
}

function executorOnline(e: { last_seen_at: string }): boolean {
  return Date.now() - new Date(e.last_seen_at).getTime() < 2 * 60_000;
}

function executorCovers(e: { targets: string[] }, target: string): boolean {
  return e.targets.includes('*') || e.targets.includes(target);
}

function diagnosticSummary(diags: ConfigDiagnostic[]): ConfigDiagnosticsReport {
  const errors = diags.filter((d) => d.severity === 'error').length;
  const warnings = diags.filter((d) => d.severity === 'warning').length;
  return { ok: errors === 0, errors, warnings, diagnostics: diags };
}

export async function inspectConfig(
  store: ConfigDiagnosticsStore | null,
  opts: { cfg: AppConfig; kbService?: ConfigDiagnosticsKbService | null } ,
): Promise<ConfigDiagnosticsReport> {
  const diags: ConfigDiagnostic[] = [];
  if (!store) return diagnosticSummary(diags);

  const [routes, targets, projects, credentials, channels, providers, buckets, alerts, chats, clients, executorTokens, kbBases] = await Promise.all([
    store.routes.list(),
    store.targets.list(),
    store.projects.list(),
    store.credentials.list(),
    store.channels.list(),
    store.toolProviders.list(),
    store.storageBuckets.list(),
    store.alertRules.list(),
    store.chatEntries.list(),
    store.clients.list(),
    store.executorTokens.list(),
    opts.kbService ? opts.kbService.listBases().catch(() => []) : Promise.resolve([]),
  ]);

  const targetMap = new Map(targets.map((t) => [t.name, t]));
  const projectMap = new Map(projects.map((p) => [p.name, p]));
  const credMap = new Map(credentials.map((c) => [c.name, c]));
  const fileCredentialNames = new Set(Object.keys(opts.cfg.llmCredentials ?? {}));
  const channelMap = new Map(channels.map((c) => [c.name, c]));
  const providerMap = new Map(providers.map((p) => [p.name, p]));
  const bucketMap = new Map(buckets.map((b) => [b.name, b]));
  const routeMap = new Map(routes.map((r) => [r.route_key, r]));
  const clientMap = new Map(clients.map((c) => [c.app_id, c]));
  const kbMap = new Map(kbBases.map((b) => [b.kb_id, b]));

  for (const credential of credentials) {
    if (fileCredentialNames.has(credential.name)) {
      add(diags, 'warning', 'credential', credential.name, 'config.json/环境变量与后台数据库存在同名模型凭证；运行时固定优先使用 config/env，后台修改该同名凭证不会生效，请只保留一个来源');
    }
  }

  for (const target of targets) {
    if (!nameOk(target.name)) add(diags, 'error', 'target', target.name || '(empty)', 'target.name 仅限小写字母/数字/中划线/下划线，长度 2..64');
    if (target.kind !== 'inhub' && target.kind !== 'executor') add(diags, 'error', 'target', target.name, 'target.kind 仅支持 inhub/executor');
    if (!Number.isInteger(Number(target.timeout_ms)) || Number(target.timeout_ms) < 0 || Number(target.timeout_ms) > 3_600_000) {
      add(diags, 'error', 'target', target.name, 'target.timeout_ms 必须是 0..3600000 的整数');
    }
  }

  for (const route of routes) {
    const id = route.route_key || '(empty)';
    const target = targetMap.get(route.target);
    const err = await validateRouteConfig(route, {
      targetExists: (name) => targetMap.has(name),
      targetNeedsProject: (name) => targetMap.get(name)?.needs_project === true,
      toolProviderExists: async (name) => providerMap.has(name),
    }, { defaultProfile: opts.cfg.defaultProfile });
    if (err) add(diags, 'error', 'route', id, err);
    if (route.route_key && !routeKeyOk(route.route_key)) add(diags, 'error', 'route', id, 'route_key 不是合法机器标识');
    if (target && !target.enabled) add(diags, 'warning', 'route', id, `引用的 target ${route.target} 当前未启用`);
    if (target?.needs_project) {
      const p = route.project ? projectMap.get(route.project) : null;
      if (!p) add(diags, 'error', 'route', id, `project ${route.project || '(空)'} 未登记`);
      else if (!p.enabled) add(diags, 'warning', 'route', id, `project ${route.project} 当前未启用`);
    }
    if (route.target === 'llm') {
      const tc = normalizeTargetConfig('llm', route.target_config ?? {});
      const credential = String(tc['credential'] ?? '').trim();
      if (credential && !hasCredential(credMap, fileCredentialNames, credential, ['chat', 'both'])) add(diags, 'error', 'route', id, `target_config.credential ${credential} 不存在、未启用或不是 chat/both`);
      const input = tc['input'] && typeof tc['input'] === 'object' && !Array.isArray(tc['input']) ? tc['input'] as Record<string, unknown> : {};
      for (const key of ['image', 'audio', 'file'] as const) {
        const part = input[key] && typeof input[key] === 'object' && !Array.isArray(input[key]) ? input[key] as Record<string, unknown> : null;
        const cred = String(part?.['credential'] ?? '').trim();
        if (cred && !hasCredential(credMap, fileCredentialNames, cred, ['chat', 'both'])) add(diags, 'error', 'route', id, `target_config.input.${key}.credential ${cred} 不存在、未启用或不是 chat/both`);
      }
    }
    const knowledge = routeKnowledgeConfig(route.knowledge);
    if (knowledge) {
      for (const kbId of knowledge.kb_ids) {
        const kb = kbMap.get(kbId);
        if (!kb) add(diags, 'error', 'route', id, `knowledge 引用的知识库 ${kbId} 不存在`);
        else if (!kb.enabled) add(diags, 'warning', 'route', id, `knowledge 引用的知识库 ${kbId} 当前未启用`);
      }
    }
    for (const source of toolSourceConfigs(route.tools)) {
      const p = providerMap.get(source.provider);
      if (!p) add(diags, 'error', 'route', id, `tools.sources[].provider ${source.provider} 未登记`);
      else if (!p.enabled) add(diags, 'warning', 'route', id, `tools.sources[].provider ${source.provider} 当前未启用`);
    }
    const send = sendMessageConfig(route.tools);
    if (send) {
      for (const chName of send.channels) {
        if (chName === '*') continue;
        const ch = channelMap.get(chName);
        if (!ch) add(diags, 'error', 'route', id, `tools.builtin.send_message.channels 引用的渠道 ${chName} 不存在`);
        else if (!ch.enabled) add(diags, 'warning', 'route', id, `tools.builtin.send_message.channels 引用的渠道 ${chName} 当前未启用`);
      }
    }
    const audience = route.audience;
    if (audience) {
      if (audience.enabled === false && (hasAudienceFilters(route) || audience.auto === true || list(audience.keywords).length)) {
        add(diags, 'warning', 'route_audience', id, 'audience.enabled=false 时受众过滤与 route=auto 规则不会生效');
      }
      for (const appId of list(audience.clients)) {
        const client = clientMap.get(appId);
        if (!client) add(diags, 'error', 'route_audience', id, `audience.clients 引用的接入方 ${appId} 不存在`);
        else if (!client.enabled) add(diags, 'warning', 'route_audience', id, `audience.clients 引用的接入方 ${appId} 当前未启用`);
      }
      for (const chName of list(audience.channels)) {
        const ch = channelMap.get(chName);
        if (!ch) add(diags, 'error', 'route_audience', id, `audience.channels 引用的渠道 ${chName} 不存在`);
        else if (!ch.enabled) add(diags, 'warning', 'route_audience', id, `audience.channels 引用的渠道 ${chName} 当前未启用`);
      }
      if ((audience.auto === true || list(audience.keywords).length) && !route.enabled) {
        add(diags, 'warning', 'route_auto', id, '该路由声明了自动分诊规则，但路由当前未启用');
      }
      if (audience.auto === true && !list(audience.keywords).length && !hasAudienceFilters(route) && (audience.priority ?? 0) === 0) {
        add(diags, 'warning', 'route_auto', id, 'route=auto 规则过宽：未配置关键词/受众过滤/优先级，容易与其他自动路由同分');
      }
    }
  }

  for (const client of clients) {
    if (!nameOk(client.app_id)) add(diags, 'error', 'client', client.app_id || '(empty)', 'app_id 仅限小写字母/数字/中划线/下划线，长度 2..64');
    const budgetErr = validateBudgetPolicy(client.budget);
    if (budgetErr) add(diags, 'error', 'client', client.app_id, budgetErr);
    for (const rk of client.allowed_routes ?? []) {
      if (rk === 'auto') {
        add(diags, 'warning', 'client', client.app_id, 'allowed_routes 不应配置 auto；route=auto 是调用参数，白名单应填写真实路由 key 或 *');
        continue;
      }
      if (rk === '*') continue;
      const r = routeMap.get(rk);
      if (!r) add(diags, 'error', 'client', client.app_id, `allowed_routes 引用的路由 ${rk} 不存在`);
      else if (!r.enabled) add(diags, 'warning', 'client', client.app_id, `allowed_routes 引用的路由 ${rk} 当前未启用`);
    }
    for (const chName of client.allowed_channels ?? []) {
      if (chName === '*') continue;
      const ch = channelMap.get(chName);
      if (!ch) add(diags, 'error', 'client', client.app_id, `allowed_channels 引用的渠道 ${chName} 不存在`);
      else if (!ch.enabled) add(diags, 'warning', 'client', client.app_id, `allowed_channels 引用的渠道 ${chName} 当前未启用`);
    }
    const reachableAuto = routes.some((r) => routeAutoEligible(r) && clientCanReachRoute(client, r.route_key));
    if (client.enabled && (client.allowed_routes ?? []).includes('*') && !reachableAuto) {
      add(diags, 'warning', 'route_auto', client.app_id, '该接入方允许全部路由，但当前没有任何可用自动分诊路由；调用 route=auto 会无候选');
    }
  }

  const autoRoutes = routes.filter(routeAutoEligible);
  for (let i = 0; i < autoRoutes.length; i += 1) {
    for (let j = i + 1; j < autoRoutes.length; j += 1) {
      const a = autoRoutes[i]!;
      const b = autoRoutes[j]!;
      if ((a.audience?.priority ?? 0) !== (b.audience?.priority ?? 0)) continue;
      const keywordOverlap = overlaps(list(a.audience?.keywords), list(b.audience?.keywords));
      const bothBroad = !list(a.audience?.keywords).length && !list(b.audience?.keywords).length;
      if (!keywordOverlap.length && !bothBroad) continue;
      const clientOverlap = overlaps(list(a.audience?.clients), list(b.audience?.clients));
      const bothPublicToClient = !list(a.audience?.clients).length && !list(b.audience?.clients).length;
      if (!clientOverlap.length && !bothPublicToClient) continue;
      const marker = bothBroad ? '宽泛候选' : `关键词 ${keywordOverlap.slice(0, 5).join(',')}`;
      add(diags, 'warning', 'route_auto', `${a.route_key}<->${b.route_key}`, `route=auto 可能同分歧义：${marker}、priority=${a.audience?.priority ?? 0}；请提高其中一个 priority 或拆分关键词/受众`);
    }
  }

  for (const channel of channels) {
    const id = channel.name || '(empty)';
    if (!nameOk(channel.name)) add(diags, 'error', 'channel', id, '渠道 name 仅限小写字母/数字/中划线/下划线，长度 2..64');
    const route = routeMap.get(channel.route_key);
    if (!route) add(diags, 'error', 'channel', id, `route_key ${channel.route_key || '(空)'} 不存在`);
    else if (!route.enabled) add(diags, 'warning', 'channel', id, `route_key ${channel.route_key} 当前未启用`);
    if (channel.kind === 'wecom') {
      if (!String(channel.config?.['token'] ?? '').trim()) add(diags, 'error', 'channel', id, 'wecom config.token 必填');
      if (!String(channel.config?.['aes_key'] ?? '').trim()) add(diags, 'error', 'channel', id, 'wecom config.aes_key 必填');
      const bucket = String(channel.config?.['bucket'] ?? '').trim();
      if (bucket && !bucketMap.has(bucket)) add(diags, 'error', 'channel', id, `config.bucket ${bucket} 未登记`);
    } else {
      add(diags, 'warning', 'channel', id, `channel.kind=${channel.kind} 当前没有内置 handler`);
    }
  }

  for (const chat of chats) {
    const id = chat.entry_key || '(empty)';
    const route = routeMap.get(chat.route_key);
    if (!route) add(diags, 'error', 'chat_entry', id, `route_key ${chat.route_key || '(空)'} 不存在`);
    else if (!route.enabled) add(diags, 'warning', 'chat_entry', id, `route_key ${chat.route_key} 当前未启用`);
    if (chat.bucket && !bucketMap.has(chat.bucket)) add(diags, 'error', 'chat_entry', id, `bucket ${chat.bucket} 未登记`);
    if (chat.ticket_client && !clients.some((c) => c.app_id === chat.ticket_client)) add(diags, 'error', 'chat_entry', id, `ticket_client ${chat.ticket_client} 未登记`);
  }

  for (const alert of alerts) {
    const id = String(alert.id ?? '?');
    const ch = channelMap.get(alert.channel);
    if (!ch) add(diags, 'error', 'alert_rule', id, `channel ${alert.channel || '(空)'} 不存在`);
    else if (!ch.enabled) add(diags, 'warning', 'alert_rule', id, `channel ${alert.channel} 当前未启用`);
    if (!alert.recipients?.length) add(diags, 'error', 'alert_rule', id, 'recipients 至少配置一个收件人');
  }

  for (const provider of providers) {
    const id = provider.name || '(empty)';
    if (!nameOk(provider.name)) add(diags, 'error', 'tool_provider', id, '工具源 name 仅限小写字母/数字/中划线/下划线，长度 2..64');
    if (!provider.base_url) add(diags, 'error', 'tool_provider', id, 'base_url 必填');
    if (!provider.secret) add(diags, 'error', 'tool_provider', id, 'secret 必填');
    if (provider.spec_source === 'url' && !provider.spec_url) add(diags, 'error', 'tool_provider', id, 'spec_source=url 时 spec_url 必填');
    if (provider.spec_source === 'inline' && !provider.spec_json) add(diags, 'warning', 'tool_provider', id, 'inline 工具源尚未保存 spec_json');
    if (provider.spec_json) {
      const parsed = parseOpenApiSpec(provider.spec_json);
      if (!parsed.ok) add(diags, 'error', 'tool_provider', id, parsed.error);
    }
    if (provider.enabled && provider.spec_json) {
      const probe = provider.authz_probe;
      if (!probe) add(diags, 'warning', 'tool_provider', id, '尚未执行授权探针；建议保存或手动探针，确认业务侧按 On-Behalf-Of fail-closed');
      else if (probe.status === 'suspect') add(diags, 'error', 'tool_provider', id, `授权探针疑似只验签未授权：${probe.reason || '声明需主体的只读工具对合成越权主体返回 2xx'}`);
      else if (probe.status === 'inconclusive') add(diags, 'warning', 'tool_provider', id, `授权探针无法判定：${probe.reason || `HTTP ${probe.http ?? '?'}`}`);
      else if (probe.status === 'skipped') add(diags, 'warning', 'tool_provider', id, `授权探针已跳过：${probe.reason || '无可用只读探针工具'}`);
    }
    if (!Number.isInteger(Number(provider.timeout_ms)) || provider.timeout_ms < 1000 || provider.timeout_ms > 60_000) add(diags, 'error', 'tool_provider', id, 'timeout_ms 必须是 1000..60000 的整数');
    if (provider.rate_limit_per_min < 0) add(diags, 'error', 'tool_provider', id, 'rate_limit_per_min 不能小于 0');
    if (provider.auto_refresh_min < 0 || provider.auto_refresh_min > 1440) add(diags, 'error', 'tool_provider', id, 'auto_refresh_min 必须是 0..1440');
    const hasEmbed = !!(provider.embed_credential || provider.embed_model || provider.embed_dim);
    if (hasEmbed) {
      if (!provider.embed_credential || !provider.embed_model || !provider.embed_dim) add(diags, 'error', 'tool_provider', id, '工具检索需要同时配置 embed_credential/embed_model/embed_dim');
      else if (!hasCredential(credMap, fileCredentialNames, provider.embed_credential, ['embedding', 'both'])) add(diags, 'error', 'tool_provider', id, `embed_credential ${provider.embed_credential} 不存在、未启用或不是 embedding/both`);
      if (provider.embed_dim && (!Number.isInteger(Number(provider.embed_dim)) || provider.embed_dim <= 0)) add(diags, 'error', 'tool_provider', id, 'embed_dim 必须是正整数');
    }
  }

  for (const bucket of buckets) {
    const id = bucket.name || '(empty)';
    if (!nameOk(bucket.name)) add(diags, 'error', 'storage_bucket', id, '存储桶登记名仅限小写字母/数字/中划线/下划线，长度 2..64');
    if (!['local', 'cos', 'oss', 's3'].includes(bucket.kind)) add(diags, 'error', 'storage_bucket', id, 'kind 仅支持 local/cos/oss/s3');
    if (bucket.kind !== 'local' && !bucket.bucket) add(diags, 'error', 'storage_bucket', id, 'bucket 必填');
    if (bucket.kind !== 'local' && !bucket.public_base_url) add(diags, 'error', 'storage_bucket', id, 'public_base_url 必填');
    if (bucket.public_base_url && !/^https?:\/\//.test(bucket.public_base_url)) add(diags, 'warning', 'storage_bucket', id, 'public_base_url 建议使用 http(s) 绝对地址');
    if (bucket.kind === 'cos' && !bucket.region) add(diags, 'error', 'storage_bucket', id, 'COS bucket 必须配置 region');
  }

  for (const token of executorTokens) {
    if (!nameOk(token.name)) add(diags, 'error', 'executor_token', token.name || '(empty)', '执行器令牌 name 仅限小写字母/数字/中划线/下划线，长度 2..64');
    for (const t of token.allowed_targets ?? []) {
      if (t === '*') continue;
      const target = targetMap.get(t);
      if (!target) add(diags, 'error', 'executor_token', token.name, `allowed_targets 引用的 target ${t} 不存在`);
      else if (target.kind !== 'executor') add(diags, 'error', 'executor_token', token.name, `allowed_targets ${t} 不是 executor 类目标`);
      else if (!target.enabled) add(diags, 'warning', 'executor_token', token.name, `allowed_targets ${t} 当前未启用`);
    }
  }

  for (const kb of kbBases) {
    if (!hasCredential(credMap, fileCredentialNames, kb.credential, ['embedding', 'both'])) {
      add(diags, 'error', 'kb_base', kb.kb_id, `embedding 凭证 ${kb.credential} 不存在、未启用或不是 embedding/both`);
    }
    for (const writer of kb.writers ?? []) {
      if (!clients.some((c) => c.app_id === writer)) add(diags, 'error', 'kb_base', kb.kb_id, `writers 引用的接入方 ${writer} 不存在`);
    }
  }

  if (store.observability) {
    const dispatch = await store.observability.dispatchStatus().catch(() => null);
    if (dispatch) {
      if (dispatch.summary.expired_leases > 0) {
        add(diags, 'error', 'runtime_dispatch', 'expired_leases', `存在 ${dispatch.summary.expired_leases} 个过期租约，任务可能需要恢复或执行器已离线`);
      }
      if (dispatch.summary.blocked_threads > 0) {
        add(diags, 'warning', 'runtime_dispatch', 'blocked_threads', `存在 ${dispatch.summary.blocked_threads} 条同 thread 队头阻塞，请在执行器页查看阻塞任务`);
      }
      if (dispatch.summary.delayed_queued > 0) {
        add(diags, 'warning', 'runtime_dispatch', 'delayed_queued', `存在 ${dispatch.summary.delayed_queued} 个延迟队列任务，若持续不下降请检查 retry/backoff 配置`);
      }
      const executors = await store.executors?.list().catch(() => []) ?? [];
      const online = executors.filter(executorOnline);
      for (const target of targets.filter((t) => t.kind === 'executor' && t.enabled)) {
        const hasOnline = online.some((e) => executorCovers(e, target.name));
        const queued = dispatch.by_target.find((x) => x.target === target.name)?.queued ?? 0;
        if (!hasOnline && queued > 0) add(diags, 'error', 'runtime_executor', target.name, `目标 ${target.name} 有 ${queued} 个排队任务，但没有在线执行器覆盖`);
        else if (!hasOnline) add(diags, 'warning', 'runtime_executor', target.name, `目标 ${target.name} 当前没有在线执行器覆盖`);
      }
      const offline = executors.filter((e) => !executorOnline(e));
      if (offline.length) add(diags, 'warning', 'runtime_executor', 'offline', `${offline.length} 个执行器超过 2 分钟未心跳`);
    }
    const mon = await store.observability.monitorSnapshot?.().catch(() => null);
    if (mon) {
      if (mon.errors_15m > 0) add(diags, 'warning', 'runtime_jobs', 'error_burst', `最近 15 分钟有 ${mon.errors_15m} 个失败任务`);
      if (mon.oldest_queued_min >= 10) add(diags, mon.oldest_queued_min >= 30 ? 'error' : 'warning', 'runtime_jobs', 'queued_backlog', `最老 queued 任务已等待 ${mon.oldest_queued_min} 分钟`);
    }
  }
  const unresolvedDlq = await store.deliveryDlq?.list(false, 20).catch(() => []) ?? [];
  if (unresolvedDlq.length) {
    add(diags, 'warning', 'runtime_delivery', 'delivery_dlq', `存在 ${unresolvedDlq.length} 条未处理送达死信，请修复渠道后重投或标记解决`);
  }

  return diagnosticSummary(diags);
}

export function formatConfigDiagnostics(report: ConfigDiagnosticsReport): string {
  if (!report.diagnostics.length) return '配置巡检通过：未发现错误或警告';
  const lines = [`配置巡检：${report.errors} error / ${report.warnings} warning`];
  for (const d of report.diagnostics.slice(0, 50)) {
    lines.push(`- [${d.severity}] ${d.area}:${d.id} ${d.message}`);
  }
  if (report.diagnostics.length > 50) lines.push(`- ... 还有 ${report.diagnostics.length - 50} 条`);
  return lines.join('\n');
}
