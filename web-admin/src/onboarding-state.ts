export type OnboardingFlow = 'business' | 'agent';
export type ResourceStatus = 'loading' | 'ready' | 'error' | 'forbidden' | 'unavailable';
export interface SetupResource<T> { status: ResourceStatus; data: T | null; error?: string }
export interface EnabledItem { enabled: boolean }
export interface SetupCredential extends EnabledItem { name: string }
export interface SetupTarget extends EnabledItem { name: string }
export interface SetupProvider extends EnabledItem { name: string }
export interface SetupRoute extends EnabledItem { route_key: string; target?: string }
export interface SetupClient extends EnabledItem { app_id: string; allowed_routes: string[] }
export interface SetupDemo { available: boolean; imported: boolean; empty: boolean }
export interface SetupAgentOverview {
  applications: Array<SetupClient & { agent_auth_enabled: boolean }>;
  setup_workspaces: Array<{ route: string; enabled: boolean; runtime_enabled: boolean; direct_enabled: boolean; source_count: number }>;
}
export interface OnboardingResources {
  credentials: SetupResource<SetupCredential[]>;
  targets: SetupResource<SetupTarget[]>;
  providers: SetupResource<SetupProvider[]>;
  routes: SetupResource<SetupRoute[]>;
  clients: SetupResource<SetupClient[]>;
  agent: SetupResource<SetupAgentOverview>;
  demo: SetupResource<SetupDemo>;
}
export type SetupStepStatus = Exclude<ResourceStatus, 'ready'> | 'configured' | 'missing' | 'optional' | 'verify';
export interface SetupStep {
  key: string;
  title: string;
  path: string;
  read: string;
  write?: string;
  create?: boolean;
  optional?: boolean;
  status: SetupStepStatus;
  detail: string;
}

export function pendingResource<T>(): SetupResource<T> { return { status: 'loading', data: null }; }

/** HTTP failures and invalid payloads are not evidence that configuration is empty. */
export function resourceFromResponse<T>(status: number, data: unknown, valid: (value: unknown) => value is T): SetupResource<T> {
  if (status === 403) return { status: 'forbidden', data: null, error: '当前账号无权读取，请联系管理员' };
  if (status === 404) return { status: 'unavailable', data: null, error: '当前实例未提供此功能' };
  if (status < 200 || status >= 300) {
    const error = data && typeof data === 'object' && 'error' in data ? String(data.error) : `HTTP ${status}`;
    return { status: 'error', data: null, error };
  }
  return valid(data) ? { status: 'ready', data } : { status: 'error', data: null, error: '响应格式不正确，请刷新重试' };
}

function records<T>(resource: SetupResource<T[]>): T[] { return resource.status === 'ready' ? resource.data ?? [] : []; }
function issue(resources: SetupResource<unknown>[]): SetupResource<unknown> | undefined {
  return resources.find((r) => r.status === 'error') ?? resources.find((r) => r.status === 'forbidden')
    ?? resources.find((r) => r.status === 'unavailable') ?? resources.find((r) => r.status === 'loading');
}
function step(base: Omit<SetupStep, 'status' | 'detail'>, dependencies: SetupResource<unknown>[], count: number, configured: string, missing: string): SetupStep {
  const failure = issue(dependencies);
  if (failure) return { ...base, status: failure.status as SetupStepStatus, detail: failure.error || '正在读取配置…' };
  return { ...base, status: count ? 'configured' : base.optional ? 'optional' : 'missing', detail: count ? configured : missing };
}
function allowed(client: SetupClient, route: string): boolean {
  return client.allowed_routes.includes('*') || client.allowed_routes.includes(route);
}

/** These steps describe saved configuration only; no object count proves a real invocation. */
export function onboardingSteps(flow: OnboardingFlow, r: OnboardingResources): SetupStep[] {
  const demoUnknown = r.demo.status !== 'ready';
  const excludeDemo = demoUnknown || r.demo.data?.imported === true;
  // A failed demo-status read cannot turn known demo IDs into real configuration.
  // Unrelated business resources remain usable even when demo status is unavailable.
  const demoDependency = (count: number, candidateExists: boolean): SetupResource<unknown>[] =>
    demoUnknown && count === 0 && candidateExists ? [r.demo] : [];
  const targets = records(r.targets).filter((t) => t.enabled && (!excludeDemo || t.name !== 'demo-agent'));
  const providers = records(r.providers).filter((p) => p.enabled && (!excludeDemo || p.name !== 'demo-business'));
  const routes = records(r.routes).filter((route) => route.enabled && (!excludeDemo || route.route_key !== 'demo_support'));
  const clients = records(r.clients).filter((client) => client.enabled && (!excludeDemo || client.app_id !== 'demo-app'));
  const connectedClients = clients.filter((client) => routes.some((route) => allowed(client, route.route_key)));
  const toolStep = step({ key: 'tools', title: '登记业务工具源', path: '/tools', read: 'tools:read', write: 'tools:write', create: true, optional: flow === 'business' },
    [r.providers, ...demoDependency(providers.length, records(r.providers).some((p) => p.enabled))], providers.length, `已有 ${providers.length} 个已启用工具源；目录与业务鉴权仍需通过实际调用验证。`,
    flow === 'business' ? '需要 AI 查询或操作业务数据时再配置；只处理文本的任务可以跳过。' : '先登记业务系统提供的工具清单。只登记接口，不会代替业务系统授予权限。');
  const routeStep = step({ key: 'routes', title: flow === 'business' ? '创建触发路由' : '准备工作空间（业务路由）', path: '/routes', read: 'routes:read', write: 'routes:write', create: true },
    [r.routes, ...demoDependency(routes.length, records(r.routes).some((route) => route.enabled))], routes.length, `已有 ${routes.length} 条已启用业务路由；请确认场景和工具范围。`,
    flow === 'business' ? '先创建并启用路由，选择执行目标；下一步才能为接入方指定可调路由。' : '工作空间复用一条业务路由。新建时仍需绑定真实调度目标：中枢模型目标（llm）需要模型凭证；外部执行器按实际运行环境配置。准备路由后再创建接入方。');
  const clientStep = step({ key: 'clients', title: '创建接入方并关联路由', path: '/clients', read: 'clients:read', write: 'clients:write', create: true },
    [r.clients, r.routes, ...demoDependency(connectedClients.length, records(r.clients).some((client) => client.enabled && records(r.routes).some((route) => route.enabled && allowed(client, route.route_key))))], connectedClients.length, `已有 ${connectedClients.length} 个已启用接入方关联业务路由；这仍只是配置记录。`,
    !routes.length ? '先准备业务路由，再选择明确的可调路由；不必为了完成向导开放全部路由。'
      : clients.length ? '已有接入方，但尚未关联已启用的业务路由。请检查可调路由。' : '为调用者创建接入方，并选定上一步的业务路由。');
  if (flow === 'business') return [
    step({ key: 'targets', title: '选择调度目标', path: '/targets', read: 'targets:read', write: 'targets:write' },
      [r.targets, ...demoDependency(targets.length, records(r.targets).some((target) => target.enabled))], targets.length, `已有 ${targets.length} 个已启用执行目标；保存记录不代表模型或执行器已经可用。`,
      '选择中枢模型或外部执行器承接任务。使用中枢模型时配置模型凭证；外部执行器按自身运行环境接入。'),
    toolStep, routeStep, clientStep,
    { key: 'verify', title: '发起一次真实业务调用', path: '/routes', read: 'routes:read', status: 'verify', detail: '在路由页打开「调用代码」，配置所选接入方的完整 Token 后发起请求，再到「任务」检查结果与执行记录（trace）。已保存配置不会自动标记为验证通过。' },
  ];
  const overview = r.agent.status === 'ready' ? r.agent.data : null;
  const linkedRoutes = new Set(routes.map((route) => route.route_key));
  const readyWorkspaces = overview?.setup_workspaces.filter((workspace) => linkedRoutes.has(workspace.route)
    && workspace.enabled && workspace.runtime_enabled && workspace.direct_enabled && workspace.source_count > 0) ?? [];
  const connectedApps = overview?.applications.filter((app) => app.enabled && app.agent_auth_enabled
    && connectedClients.some((client) => client.app_id === app.app_id)
    && readyWorkspaces.some((workspace) => allowed(app, workspace.route))) ?? [];
  const possiblyConnectedApp = overview?.applications.some((app) => app.enabled && app.agent_auth_enabled
    && records(r.clients).some((client) => client.enabled && client.app_id === app.app_id
      && overview.setup_workspaces.some((workspace) => workspace.enabled && workspace.runtime_enabled
        && workspace.direct_enabled && workspace.source_count > 0 && allowed(app, workspace.route)
        && allowed(client, workspace.route) && records(r.routes).some((route) => route.enabled && route.route_key === workspace.route))));
  return [toolStep, routeStep, clientStep,
    step({ key: 'agent', title: '配置业务授权与工具范围', path: '/agent-clients', read: 'clients:read', write: 'clients:write' },
      [r.agent, r.routes, r.clients, ...demoDependency(connectedApps.length, !!possiblyConnectedApp)], connectedApps.length, `已有 ${connectedApps.length} 个接入方配置了授权入口与工作空间工具通道；登录及真实动作仍待验证。`,
      '打开「本地智能体」的「配置接入」，保存业务授权入口，启用工作空间及工具通道，选择工具范围。本地客户端使用自身模型；已有路由的连接与业务授权不要求额外添加中枢模型凭证。'),
    { key: 'verify', title: '在本地客户端登录并验证', path: '/agent-clients', read: 'clients:read', status: 'verify', detail: '生成公开连接配置，在本地客户端登录业务系统，先执行一个只读动作，再核对设备授权与运行记录。工具和写操作仍受业务权限及审批约束。' },
  ];
}

export interface SetupSmoke {
  hub: string; pass: number; fail: number; skip: number;
  checks: Array<{ name: string; status: 'pass' | 'fail' | 'skip'; detail?: string }>;
  run?: { route?: string; request_id?: string; job_id?: string; status?: string };
}
export function demoVerified(smoke: SetupSmoke | null): boolean {
  return !!smoke && smoke.fail === 0 && smoke.run?.route === 'demo_support' && !!smoke.run.job_id
    && smoke.run.status === 'done' && smoke.checks.some((check) => check.status === 'pass' && /trace|debug_bundle/i.test(check.name));
}
