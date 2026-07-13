import { randomUUID } from 'node:crypto';
import { validateBudgetPolicy } from '../runtime/budget-runtime';
import type { PageRule } from '../platform/pagecontext';
import type { AlertRule, Channel, ChatEntry, Client, Credential, ExecutorToken, StorageBucket, TargetDef, ToolProvider } from '../contracts/types';
import { parseOpenApiSpec } from '../contracts/openapi-tools';

const RESOURCE_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

type PrepareResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail<T = never>(error: string): PrepareResult<T> {
  return { ok: false, error };
}

function str(v: unknown): string {
  return String(v ?? '').trim();
}

function optionalStr(v: unknown): string | undefined {
  const s = str(v);
  return s || undefined;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [];
}

function object(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function resourceName(v: unknown, label: string): PrepareResult<string> {
  const name = str(v);
  if (!RESOURCE_NAME_RE.test(name)) return fail(`${label} 仅限小写字母/数字/中划线/下划线，且长度 2..64`);
  return { ok: true, value: name };
}

export function prepareClientConfig(input: Partial<Client> & { rotate_token?: boolean }): PrepareResult<Omit<Client, 'token'>> {
  const appId = str(input.app_id) || `app-${randomUUID().slice(0, 8)}`;
  if (!RESOURCE_NAME_RE.test(appId)) return fail('app_id 仅限小写字母/数字/中划线/下划线，且长度 2..64');
  const name = str(input.name);
  if (!name) return fail('name 必填');
  const allowedRoutes = stringList(input.allowed_routes);
  if (!allowedRoutes.length) return fail('allowed_routes 至少选一个路由（或 ["*"]）');
  const budgetErr = validateBudgetPolicy(input.budget, 'client.budget');
  if (budgetErr) return fail(budgetErr);
  const budget = object(input.budget);
  return {
    ok: true,
    value: {
      app_id: appId,
      name,
      allowed_routes: allowedRoutes,
      allowed_channels: stringList(input.allowed_channels),
      rate_limit_per_min: Math.max(Number(input.rate_limit_per_min ?? 60) || 0, 0),
      budget: Object.keys(budget).length ? budget : undefined,
      enabled: input.enabled !== false,
      description: optionalStr(input.description),
    },
  };
}

export function prepareExecutorTokenConfig(input: Partial<ExecutorToken>): PrepareResult<Omit<ExecutorToken, 'token'>> {
  const name = resourceName(input.name, '令牌标识');
  if (!name.ok) return name;
  const allowed = stringList(input.allowed_targets);
  if (!allowed.length) return fail('allowed_targets 至少选一个 target（或 ["*"]）');
  return {
    ok: true,
    value: {
      name: name.value,
      allowed_targets: allowed,
      enabled: input.enabled !== false,
      description: optionalStr(input.description),
    },
  };
}

export function prepareCredentialConfig(input: Partial<Credential>): PrepareResult<Credential> {
  const name = resourceName(input.name, '凭证名');
  if (!name.ok) return name;
  const baseUrl = str(input.base_url);
  if (!baseUrl) return fail('base_url 必填');
  const kind: Credential['kind'] = input.kind === 'embedding' || input.kind === 'both' ? input.kind : 'chat';
  return {
    ok: true,
    value: {
      name: name.value,
      kind,
      base_url: baseUrl,
      api_key: str(input.api_key),
      default_model: optionalStr(input.default_model),
      enabled: input.enabled !== false,
      description: optionalStr(input.description),
    },
  };
}

export function prepareTargetConfig(input: Partial<TargetDef>, deps: { hasInhubAdapter(name: string): boolean }): PrepareResult<TargetDef> {
  const name = resourceName(input.name, 'target 名');
  if (!name.ok) return name;
  const kind: TargetDef['kind'] = input.kind === 'inhub' ? 'inhub' : 'executor';
  if (kind === 'inhub' && !deps.hasInhubAdapter(name.value)) {
    return fail(`inhub 类目标需要中枢内置同名适配器；自定义目标请用 executor 类`);
  }
  return {
    ok: true,
    value: {
      name: name.value,
      kind,
      stateless: input.stateless === true,
      needs_project: input.needs_project === true,
      timeout_ms: Math.min(Math.max(Number(input.timeout_ms ?? 0) || 0, 0), 3600000),
      enabled: input.enabled !== false,
      description: optionalStr(input.description),
    },
  };
}

export function prepareStorageBucketConfig(input: Partial<StorageBucket>): PrepareResult<StorageBucket> {
  const name = resourceName(input.name, '存储桶登记名');
  if (!name.ok) return name;
  const kind: StorageBucket['kind'] = input.kind === 'local' || input.kind === 'oss' || input.kind === 's3' ? input.kind : 'cos';
  const bucket = str(input.bucket);
  if (kind !== 'local' && !bucket) return fail('桶名 bucket 必填');
  const publicBaseUrl = str(input.public_base_url).replace(/\/+$/, '');
  if (kind !== 'local' && !publicBaseUrl) return fail('公开访问域名 public_base_url 必填（拼最终媒体 URL 用）');
  const region = str(input.region);
  if (kind === 'cos' && !region) return fail('COS 必须填地域 region（如 ap-shanghai）');
  return {
    ok: true,
    value: {
      name: name.value,
      kind,
      region,
      bucket: bucket || 'local',
      endpoint: optionalStr(input.endpoint),
      access_key: str(input.access_key),
      secret_key: str(input.secret_key),
      public_base_url: publicBaseUrl,
      path_prefix: str(input.path_prefix) || 'bailing/chat',
      enabled: input.enabled !== false,
      description: optionalStr(input.description),
    },
  };
}

export async function prepareChannelConfig(
  input: Partial<Channel>,
  deps: { isNew(name: string): Promise<boolean> },
): Promise<PrepareResult<Channel>> {
  const name = resourceName(input.name, '渠道标识');
  if (!name.ok) return name;
  const kind = str(input.kind) || 'wecom';
  if (kind !== 'wecom') return fail(`暂只支持 kind=wecom（${kind} 待接入）`);
  const routeKey = str(input.route_key);
  if (!routeKey) return fail('必须绑定一条路由 route_key（消息下发给哪个大脑）');
  const cfgIn = object(input.config);
  if (await deps.isNew(name.value)) {
    if (!str(cfgIn.token) || !str(cfgIn.aes_key)) {
      return fail('企微渠道必填 Token 与 EncodingAESKey（新建时）');
    }
  }
  return {
    ok: true,
    value: {
      name: name.value,
      kind,
      route_key: routeKey,
      config: {
        corpid: str(cfgIn.corpid),
        token: str(cfgIn.token),
        aes_key: str(cfgIn.aes_key),
        agentid: str(cfgIn.agentid),
        secret: str(cfgIn.secret),
        reply_wait_ms: Math.min(Math.max(Number(cfgIn.reply_wait_ms ?? 4000) || 4000, 300), 4500),
        bucket: str(cfgIn.bucket),
      },
      enabled: input.enabled !== false,
      description: optionalStr(input.description),
    },
  };
}

export async function prepareAlertRuleConfig(
  input: Partial<AlertRule>,
  deps: { channelExists(name: string): Promise<boolean> },
): Promise<PrepareResult<Omit<AlertRule, 'id'> & { id?: number }>> {
  const channel = str(input.channel);
  if (!channel || !(await deps.channelExists(channel))) return fail(`渠道 ${channel || '(空)'} 不存在（先在「渠道」建）`);
  const recipients = stringList(input.recipients);
  if (!recipients.length) return fail('至少填一个收件人（渠道原生 id，如企微 userid）');
  const id = Number(input.id);
  return {
    ok: true,
    value: {
      ...(Number.isFinite(id) && id > 0 ? { id } : {}),
      event_prefix: str(input.event_prefix).slice(0, 64),
      channel,
      recipients,
      cooldown_min: Math.min(Math.max(Number(input.cooldown_min ?? 60) || 60, 1), 1440),
      enabled: input.enabled !== false,
      description: optionalStr(input.description)?.slice(0, 255),
    },
  };
}

function clampNum(v: unknown, lo: number, hi: number): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : undefined;
}

function safeHttpUrl(v: unknown): string | undefined {
  const s = str(v);
  return /^https?:\/\/.{3,}/.test(s) ? s.slice(0, 255) : undefined;
}

function chatAppearance(v: unknown): ChatEntry['appearance'] | undefined {
  const apIn = object(v);
  const appearance: ChatEntry['appearance'] = {};
  const width = clampNum(apIn.width, 280, 720); if (width !== undefined) appearance.width = width;
  const height = clampNum(apIn.height, 360, 900); if (height !== undefined) appearance.height = height;
  if (apIn.title_align === 'left' || apIn.title_align === 'center') appearance.title_align = apIn.title_align;
  if (apIn.position === 'left' || apIn.position === 'right') appearance.position = apIn.position;
  const offsetX = clampNum(apIn.offset_x, 0, 400); if (offsetX !== undefined) appearance.offset_x = offsetX;
  const offsetY = clampNum(apIn.offset_y, 0, 400); if (offsetY !== undefined) appearance.offset_y = offsetY;
  const avatar = safeHttpUrl(apIn.avatar); if (avatar) appearance.avatar = avatar;
  const launcherIcon = safeHttpUrl(apIn.launcher_icon); if (launcherIcon) appearance.launcher_icon = launcherIcon;
  if (apIn.resizable === true) appearance.resizable = true;
  if (apIn.ai_notice === false) appearance.ai_notice = false;
  if (apIn.powered_by_visible === false) appearance.powered_by_visible = false;
  const poweredByText = optionalStr(apIn.powered_by_text); if (poweredByText) appearance.powered_by_text = poweredByText.slice(0, 80);
  return Object.keys(appearance).length ? appearance : undefined;
}

export async function prepareChatEntryConfig(
  input: Record<string, unknown>,
  deps: {
    routeExists(routeKey: string): Promise<boolean>;
    entryExists(entryKey: string): Promise<boolean>;
    clientExists(appId: string): Promise<boolean>;
    bucketExists(name: string): Promise<boolean>;
  },
): Promise<PrepareResult<ChatEntry>> {
  const name = str(input.name);
  if (!name) return fail('name 必填');
  const routeKey = str(input.route_key);
  if (!routeKey || !(await deps.routeExists(routeKey))) return fail(`路由 ${routeKey || '(空)'} 不存在（先在「触发路由」建）`);
  let entryKey = str(input.entry_key);
  if (entryKey && !(await deps.entryExists(entryKey))) return fail('入口不存在（entry_key 由服务端生成，新建请留空）');
  if (!entryKey) entryKey = `pub_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const ticketClient = str(input.ticket_client);
  if (ticketClient && !(await deps.clientExists(ticketClient))) return fail(`票据签发方 ${ticketClient} 不是已登记的接入方`);
  const bucketName = str(input.bucket);
  if (bucketName && !(await deps.bucketExists(bucketName))) return fail(`存储桶 ${bucketName} 未登记（先在「对象存储」建）`);

  return {
    ok: true,
    value: {
      entry_key: entryKey,
      name,
      route_key: routeKey,
      enabled: input.enabled !== false,
      allowed_origins: Array.isArray(input.allowed_origins)
        ? input.allowed_origins.map((x) => String(x).trim().replace(/\/+$/, '')).filter(Boolean)
        : [],
      rate_limit_per_min: Math.min(Math.max(Number(input.rate_limit_per_min ?? 20) || 20, 1), 600),
      ticket_client: ticketClient || undefined,
      bucket: bucketName || undefined,
      title: optionalStr(input.title)?.slice(0, 64),
      greeting: optionalStr(input.greeting)?.slice(0, 255),
      color: /^#[0-9a-fA-F]{3,8}$/.test(str(input.color)) ? str(input.color) : undefined,
      appearance: chatAppearance(input.appearance),
      description: optionalStr(input.description),
    },
  };
}

export async function preparePageContextConfig(
  input: Record<string, unknown>,
  deps: { entryExists(entryKey: string): Promise<boolean> },
): Promise<PrepareResult<PageRule>> {
  const entryKey = str(input.entry_key);
  if (!entryKey || !(await deps.entryExists(entryKey))) return fail(`聊天入口 ${entryKey || '(空)'} 不存在`);
  const urlPattern = str(input.url_pattern);
  if (!urlPattern) return fail('url_pattern 必填（如 */member/list*）');
  const id = Number(input.id);
  return {
    ok: true,
    value: {
      ...(Number.isFinite(id) && id > 0 ? { id } : {}),
      entry_key: entryKey,
      url_pattern: urlPattern.slice(0, 255),
      page_key: optionalStr(input.page_key)?.slice(0, 64),
      page_name: optionalStr(input.page_name)?.slice(0, 128),
      description: optionalStr(input.description)?.slice(0, 1000),
      // kb_tag 列保留给页面标签加权检索；该能力未实现前不接受写入，避免半接线。
      priority: Number(input.priority) || 0,
      enabled: input.enabled !== false,
    },
  };
}

export function prepareToolProviderConfig(
  input: Record<string, unknown>,
  old?: ToolProvider | null,
): PrepareResult<ToolProvider> {
  const name = resourceName(input.name, '工具源名');
  if (!name.ok) return name;
  const baseUrl = str(input.base_url).replace(/\/+$/, '');
  if (!baseUrl) return fail('base_url 必填');
  const secret = str(input.secret) || old?.secret || '';
  if (!secret) return fail('secret 必填（业务侧验签用，建议 32 位随机串）');
  const specSource: ToolProvider['spec_source'] = input.spec_source === 'url' ? 'url' : 'inline';
  const specUrl = optionalStr(input.spec_url);
  if (specSource === 'url' && !specUrl) return fail('spec_source=url 时 spec_url 必填');

  let specJson = typeof input.spec_json === 'string' && input.spec_json.trim() ? input.spec_json : old?.spec_json;
  if (specJson) {
    const parsed = parseOpenApiSpec(specJson);
    if (!parsed.ok) return fail(parsed.error);
    specJson = parsed.canonicalJson;
  }

  const embedCredential = input.embed_credential !== undefined ? optionalStr(input.embed_credential) : old?.embed_credential;
  const embedModel = input.embed_model !== undefined ? optionalStr(input.embed_model) : old?.embed_model;
  const embedDim = input.embed_dim !== undefined ? (Number(input.embed_dim) || undefined) : old?.embed_dim;
  if (embedDim !== undefined && (!Number.isInteger(embedDim) || embedDim <= 0)) return fail('embed_dim 必须是正整数');

  return {
    ok: true,
    value: {
      name: name.value,
      base_url: baseUrl,
      spec_source: specSource,
      spec_url: specUrl,
      spec_json: specJson,
      spec_refreshed_at: specJson && specJson !== old?.spec_json ? new Date().toISOString() : old?.spec_refreshed_at,
      authz_probe: old?.authz_probe,
      secret,
      log_payload: input.log_payload !== false,
      timeout_ms: Math.min(Math.max(Number(input.timeout_ms ?? old?.timeout_ms ?? 10000) || 10000, 1000), 60000),
      rate_limit_per_min: Math.max(Number(input.rate_limit_per_min ?? old?.rate_limit_per_min ?? 120) || 0, 0),
      auto_refresh_min: Math.min(Math.max(Number(input.auto_refresh_min ?? old?.auto_refresh_min ?? 0) || 0, 0), 1440),
      enabled: input.enabled !== false,
      description: optionalStr(input.description),
      embed_credential: embedCredential,
      embed_model: embedModel,
      embed_dim: embedDim,
    },
  };
}
