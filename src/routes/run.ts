// 业务触发入口：POST /run — 接入方/admin 带 token 触发，解析路由/会话/项目后交 engine.launchJob。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readBody, send } from '../app/http';
import type { EngineRuntime } from '../app/engine';
import { type Principal, clientAllowsRoute, rateLimitedFor } from '../app/auth';
import { resolveTargetDef } from '../core/targets/resolve';
import type { Route, RunRequest, SessionTarget } from '../core/contracts/types';
import { audienceAllows, principalKey, resolvePrincipal } from '../core/runtime/identity-runtime';
import { selectAutoRoute } from '../core/runtime/routing-runtime';
import type { RuntimeActor, RuntimeContext, RuntimeSource } from '../core/edition';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { TargetRegistry } from '../core/targets/registry';

interface RuntimeContextInput {
  source: RuntimeSource;
  requestId: string;
  principal?: Principal | null;
  actor?: RuntimeActor;
}

const CLIENT_ROUTE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const CLIENT_RUN_FIELDS = new Set(['request_id', 'route', 'input', 'metadata', 'callback_url']);
const AGENT_RUN_FIELDS = new Set(['request_id', 'route', 'input', 'metadata']);
const AGENT_RESERVED_METADATA_FIELDS = new Set([
  'principal', 'subject', 'operator', 'principal_id', 'user_id', 'uid', 'operator_id',
  'visitor_uid', 'operator_uid', 'tenant', 'tenant_id', 'org_id', 'workspace_id',
  'roles', 'role', 'audience', 'principal_type', 'user_type', 'client_app_id', 'source',
  'session_id', 'on_behalf_of', 'agent_session_id', 'agent_client_app_id', 'agent_device_label',
]);

function agentAllowsRoute(principal: Extract<Principal, { kind: 'agent' }>, routeKey: string): boolean {
  return principal.session.allowed_routes.includes('*') || principal.session.allowed_routes.includes(routeKey);
}

function agentUserMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !AGENT_RESERVED_METADATA_FIELDS.has(key)));
}

function agentSubjectScope(principal: Extract<Principal, { kind: 'agent' }>): string {
  // Agent 与旧 Client /run 使用不同命名空间；scope 只由业务后端批准的主体派生，
  // 不读取用户 metadata。client_app_id + NUL + on_behalf_of 共同入摘要，
  // 避免不同 Client 恰好采用相同不透明主体值时共用历史。
  const subjectHash = createHash('sha256')
    .update('bailinghub.agent-subject.v1\0', 'utf8')
    .update(principal.session.client_app_id, 'utf8')
    .update('\0', 'utf8')
    .update(principal.session.on_behalf_of, 'utf8')
    .digest('hex');
  return `agent-subject:${subjectHash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validCallbackUrl(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface RunApiDeps {
  cfg: Pick<AppConfig, 'defaultProfile'>;
  isPaused: () => boolean;
  runtimeContextFor: (input: RuntimeContextInput) => Promise<RuntimeContext>;
  runtimeStoresFor: (ctx: RuntimeContext) => { state: RuntimeStateStore; config: ConfigStoreContract | null };
  resolveProjectPathFor: (config: ConfigStoreContract | null, name: string) => Promise<string | null>;
  engineForContext: (ctx: RuntimeContext) => Pick<EngineRuntime, 'launchJob'>;
  targetRegistry?: TargetRegistry;
}

export async function handleRunFor(deps: RunApiDeps, req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
  if (deps.isPaused()) { send(res, 503, { status: 'paused' }); return; }
  const rawBody = await readBody(req);
  if (!isRecord(rawBody)) {
    send(res, 400, { error: '请求体必须是 JSON 对象' });
    return;
  }
  const body = rawBody as Partial<RunRequest>;
  if (typeof body.request_id !== 'string' || !body.request_id.trim() || body.request_id.length > 128 ||
      typeof body.input !== 'string' || !body.input.trim() || body.input.length > 100_000) {
    send(res, 400, { error: 'request_id / input 必填' });
    return;
  }
  if (body.metadata !== undefined && !isRecord(body.metadata)) {
    send(res, 400, { error: 'metadata 必须是 JSON 对象' });
    return;
  }
  if (body.callback_url !== undefined &&
      (typeof body.callback_url !== 'string' || !validCallbackUrl(body.callback_url))) {
    send(res, 400, { error: 'callback_url 必须是长度不超过 2048 的 HTTP(S) URL' });
    return;
  }
  const ctx = await deps.runtimeContextFor({ source: 'run', requestId: body.request_id, principal });
  const { state: store, config: cfgStore } = deps.runtimeStoresFor(ctx);
  const engine = deps.engineForContext(ctx);
  const suppliedMetadata = (body.metadata as Record<string, unknown>) ?? {};
  const agent = principal.kind === 'agent' ? principal : null;
  // Agent 身份字段只从服务端会话注入；同名用户 metadata 永远被覆盖。
  const metadata: Record<string, unknown> = agent
    ? {
        ...agentUserMetadata(suppliedMetadata),
        principal: { ...agent.session.principal },
        on_behalf_of: agent.session.on_behalf_of,
        visitor_uid: agent.session.on_behalf_of,
        operator_uid: agent.session.on_behalf_of,
        agent_session_id: agent.session.session_id,
        agent_client_app_id: agent.session.client_app_id,
        agent_device_label: agent.session.device_label,
      }
    : suppliedMetadata;

  // 接入方策略闸门：只能走 route（不许自带 project/profile 绕过路由配置）+ 路由白名单 + 限速
  const client = principal.kind === 'client' || principal.kind === 'agent' ? principal.client : null;
  if (client) {
    if (typeof body.route !== 'string' || !CLIENT_ROUTE_PATTERN.test(body.route)) {
      send(res, 400, { error: '接入方 route 必须匹配 ^[a-z0-9][a-z0-9_-]{1,63}$' });
      return;
    }
    if (body.project || body.profile) { send(res, 403, { error: '接入方不可覆盖 project/profile（由路由配置决定）' }); return; }
    const allowedFields = agent ? AGENT_RUN_FIELDS : CLIENT_RUN_FIELDS;
    const unknownFields = Object.keys(rawBody).filter((key) => !allowedFields.has(key));
    if (unknownFields.length > 0) {
      send(res, 400, { error: `${agent ? 'Agent' : '接入方'}请求包含未声明字段: ${unknownFields.join(', ')}` });
      return;
    }
    if (body.route !== 'auto' && !clientAllowsRoute(client, body.route)) { send(res, 403, { error: `接入方 ${client.app_id} 无权调用路由 ${body.route}` }); return; }
    if (agent && body.route !== 'auto' && !agentAllowsRoute(agent, body.route)) { send(res, 403, { error: `Agent 会话无权调用路由 ${body.route}` }); return; }
    if (await rateLimitedFor(cfgStore, client)) { send(res, 429, { error: `超出限速（${client.rate_limit_per_min}/分钟），请稍后重试同 request_id` }); return; }
  }
  const requestChannel = agent?.session.principal.channel ?? (client?.app_id ?? 'admin');
  const actor = resolvePrincipal({ metadata, clientAppId: client?.app_id ?? null, channel: requestChannel });

  let route: Route | null = null;
  let resolvedRouteKey = body.route ?? null;
  let routeDecision: Record<string, unknown> | undefined;
  let target = 'llm';
  let project = body.project;
  let profileName = body.profile;
  let callbackUrl = agent ? undefined : body.callback_url;
  let session: SessionTarget;
  let threadScope = ''; // 对话线索 scope（与会话 scope 同语义）

  if (body.route) {
    if (!cfgStore) { send(res, 400, { error: 'route 解析需要 mysql 后端' }); return; }
    if (body.route === 'auto') {
      const picked = selectAutoRoute({
        routes: await cfgStore.routes.list(),
        text: body.input,
        metadata,
        client,
        principal: actor,
        channel: requestChannel,
      });
      routeDecision = {
        mode: 'auto',
        ok: picked.ok,
        candidates: picked.candidates.map((c) => ({ route_key: c.route.route_key, score: c.score, reasons: c.reasons })),
        ...(picked.error ? { error: picked.error } : {}),
      };
      if (!picked.ok || !picked.route) {
        send(res, picked.error === 'route_auto_ambiguous' ? 409 : 400, { error: picked.error === 'route_auto_ambiguous' ? 'route=auto 命中多个同分候选，请提高 priority 或补 keywords' : 'route=auto 未匹配到可用路由', decision: routeDecision });
        return;
      }
      route = picked.route;
      resolvedRouteKey = route.route_key;
    } else {
      route = await cfgStore.routes.get(body.route);
    }
    if (!route) { send(res, 400, { error: `未知 route: ${body.route}` }); return; }
    if (!route.enabled) { send(res, 400, { error: `route 已停用: ${body.route}` }); return; }
    if (client && !clientAllowsRoute(client, route.route_key)) { send(res, 403, { error: `接入方 ${client.app_id} 无权调用路由 ${route.route_key}` }); return; }
    if (agent && !agentAllowsRoute(agent, route.route_key)) { send(res, 403, { error: `Agent 会话无权调用路由 ${route.route_key}` }); return; }
    const audience = audienceAllows(route.audience, actor);
    if (!audience.ok) { send(res, 403, { error: `主体无权进入路由 ${route.route_key}`, reason: audience.reason }); return; }
    target = route.target;
    project = route.project;
    profileName = body.profile ?? route.profile;
    callbackUrl = agent ? undefined : (body.callback_url ?? route.default_callback_url);
    if (agent && (route.session_policy === 'fixed' || route.session_policy === 'passthrough')) {
      send(res, 403, { error: `Agent API 不允许 session_policy=${route.session_policy}；请使用 new 或 per_key` });
      return;
    }
    const s = agent && route.session_policy === 'per_key'
      ? await cfgStore.conversations.sessionForScope(route.route_key, agentSubjectScope(agent))
      : await cfgStore.conversations.resolveSession(route, metadata);
    session = { sessionId: s.sessionId, isContinue: s.isContinue };
    threadScope = s.scopeKey || `req:${body.request_id}`; // new 策略每单自成线索
  } else {
    session = { sessionId: randomUUID(), isContinue: false };
  }

  const targetDef = await resolveTargetDef(cfgStore, target, deps.targetRegistry);
  if (!targetDef) { send(res, 400, { error: `未知 target: ${target}（需先在「调度目标」注册）` }); return; }
  if (targetDef.enabled === false) { send(res, 400, { error: `target 已停用: ${target}` }); return; }

  const projectPath = project ? await deps.resolveProjectPathFor(cfgStore as ConfigStoreContract | null, project) : null;
  if (targetDef.needs_project && !projectPath) {
    send(res, 400, { error: project ? `未登记的 project: ${project}` : `target ${target} 需要 project（建议用 route 指定）` });
    return;
  }

  // 幂等（接入方只能撞自己的 request_id，防跨方碰撞/探测）
  const existing = await store.findByRequestId(body.request_id);
  if (existing) {
    const existingAgentSessionId = existing.agent_session_id ?? '';
    if (agent && (existing.client_app_id !== client?.app_id || existingAgentSessionId !== agent.session.session_id)) {
      send(res, 409, { error: 'request_id 与其他 Agent 会话冲突，请换用带本会话前缀的 request_id' });
      return;
    }
    if (!agent && client && (existing.client_app_id !== client.app_id || !!existingAgentSessionId)) {
      send(res, 409, { error: 'request_id 与其他接入方冲突，请换用带自身前缀的 request_id' });
      return;
    }
    send(res, 202, { job_id: existing.job_id, status: existing.status, request_id: existing.request_id });
    return;
  }

  profileName = profileName ?? deps.cfg.defaultProfile;
  const principalId = principalKey(actor) ?? (typeof metadata['principal'] === 'string' && metadata['principal'] ? String(metadata['principal']).slice(0, 64) : null);
  const jobMetadata = {
    ...metadata,
    ...(actor ? { principal: actor } : {}),
    ...(routeDecision ? { route_decision: routeDecision } : {}),
  };

  const job = await engine.launchJob({
    requestId: body.request_id, fullInput: body.input,
    route, routeKey: resolvedRouteKey,
    target, project: project ?? null, projectPath,
    profileName, permission: route?.permission, source: agent ? `agent:${client!.app_id}` : (client ? client.app_id : (body.source ?? 'unknown')),
    clientAppId: client?.app_id, metadata: jobMetadata, callbackUrl,
    session, threadScope, principalId, channel: agent ? `agent:${client!.app_id}` : (client?.app_id ?? 'admin'),
    ...(agent ? {
      agentAttribution: {
        agentSessionId: agent.session.session_id,
        clientAppId: agent.session.client_app_id,
        subjectId: agent.session.principal.id,
        ...(agent.session.principal.tenant ? { businessTenantRef: agent.session.principal.tenant } : {}),
        onBehalfOf: agent.session.on_behalf_of,
      },
    } : {}),
  });
  if (client && cfgStore) void cfgStore.clients.touch(client.app_id).catch(() => { /* 观测字段，失败不影响主流程 */ });

  send(res, 202, { job_id: job.job_id, status: job.status, request_id: job.request_id, route: resolvedRouteKey, target, session_id: session.sessionId, continue: session.isContinue });
}
