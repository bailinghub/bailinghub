// 智能体客户端管理中心：聚合既有接入方、Agent Session 与 Agent Run。
// 不创建第二套 Client 资源，也不复用“执行器”概念；所有投影都排除 token、prompt、工具参数和业务结果。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '../app/auth';
import { send } from '../app/http';
import { routeAgentClientConfig } from '../core/config/route-config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { AgentClientAdminStats } from '../infrastructure/config/config-agent-client-runtime-repository';
import type { AgentSessionAdminState } from '../infrastructure/config/config-agent-auth-repository';

export interface AdminAgentClientsApiDeps {
  configStore: ConfigStoreContract;
  stateStore: RuntimeStateStore;
  now: () => string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

function windowDays(value: string | null): number {
  const n = Math.round(Number(value) || 30);
  return Math.min(Math.max(n, 1), 90);
}

function sinceFor(nowValue: string, days: number): string {
  const now = new Date(nowValue);
  const base = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  return new Date(base - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
}

function emptyStats(clientAppId: string): AgentClientAdminStats {
  return {
    client_app_id: clientAppId,
    runs: 0,
    conversations: 0,
    completed: 0,
    failed: 0,
    tool_calls: 0,
    total_tokens: 0,
    approvals: {},
  };
}

function addApprovals(target: Record<string, number>, source: Record<string, number>): void {
  for (const [status, value] of Object.entries(source)) target[status] = (target[status] ?? 0) + value;
}

function actorOf(principal: Principal): string {
  return principal.kind === 'admin' ? principal.username ?? 'admin-token' : 'unknown';
}

export async function handleAdminAgentClientsApiFor(
  deps: AdminAgentClientsApiDeps,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  principal: Principal,
): Promise<boolean> {
  if (!path.startsWith('/admin/api/agent-clients')) return false;
  const agentAuth = deps.configStore.agentAuth;
  const runtime = deps.configStore.agentClientRuntime;
  if (!agentAuth || !runtime) {
    send(res, 503, { error: '智能体客户端管理中心需要 MySQL Agent Auth 与 Runtime 账本' });
    return true;
  }

  if (path === '/admin/api/agent-clients/overview' && method === 'GET') {
    const q = new URL(req.url ?? path, 'http://bailing.local').searchParams;
    const days = windowDays(q.get('days'));
    const now = new Date(deps.now());
    const [clients, routes, stats, sessions] = await Promise.all([
      deps.configStore.clients.list(),
      deps.configStore.routes.list(),
      runtime.statsForAdmin({ since: sinceFor(deps.now(), days) }),
      agentAuth.sessionSummaryForAdmin(now),
    ]);
    const byClient = new Map(stats.map((item) => [item.client_app_id, item]));
    const applications = clients.map((client) => {
      const clientStats = byClient.get(client.app_id) ?? emptyStats(client.app_id);
      return {
        app_id: client.app_id,
        name: client.name,
        enabled: client.enabled,
        agent_auth_enabled: Boolean(client.agent_authorize_url),
        agent_authorize_url: client.agent_authorize_url ?? null,
        allowed_routes: client.allowed_routes,
        last_used_at: client.last_used_at ?? null,
        stats: clientStats,
      };
    });
    const totals = stats.reduce((sum, item) => {
      sum.runs += item.runs;
      sum.conversations += item.conversations;
      sum.completed += item.completed;
      sum.failed += item.failed;
      sum.tool_calls += item.tool_calls;
      sum.total_tokens += item.total_tokens;
      addApprovals(sum.approvals, item.approvals);
      return sum;
    }, { runs: 0, conversations: 0, completed: 0, failed: 0, tool_calls: 0, total_tokens: 0, approvals: {} as Record<string, number> });
    send(res, 200, {
      days,
      applications,
      workspaces: routes.filter((route) => Boolean(routeAgentClientConfig(route))).map((route) => ({
        route: route.route_key,
        name: route.name,
        description: route.description ?? '',
      })),
      summary: {
        applications: applications.length,
        agent_auth_enabled: applications.filter((item) => item.agent_auth_enabled).length,
        sessions,
        ...totals,
        failure_rate: totals.runs ? totals.failed / totals.runs : 0,
      },
    });
    return true;
  }

  if (path === '/admin/api/agent-clients/sessions' && method === 'GET') {
    const q = new URL(req.url ?? path, 'http://bailing.local').searchParams;
    const clientAppId = String(q.get('client_app_id') ?? '').trim();
    if (clientAppId && !APP_ID_RE.test(clientAppId)) { send(res, 400, { error: 'client_app_id 无效' }); return true; }
    const rawState = String(q.get('state') ?? 'all');
    const state: AgentSessionAdminState | 'all' = ['active', 'expired', 'revoked'].includes(rawState)
      ? rawState as AgentSessionAdminState
      : 'all';
    send(res, 200, await agentAuth.listSessionsForAdmin({
      ...(clientAppId ? { clientAppId } : {}),
      state,
      limit: Number(q.get('limit')) || 50,
      offset: Number(q.get('offset')) || 0,
      now: new Date(deps.now()),
    }));
    return true;
  }

  const revokeMatch = path.match(/^\/admin\/api\/agent-clients\/sessions\/([0-9a-f-]{36})\/revoke$/i);
  if (revokeMatch && method === 'POST') {
    const sessionId = revokeMatch[1]!;
    if (!UUID_RE.test(sessionId)) { send(res, 404, { error: 'Agent Session 不存在' }); return true; }
    const session = await agentAuth.getSessionForAdmin(sessionId, new Date(deps.now()));
    if (!session) { send(res, 404, { error: 'Agent Session 不存在' }); return true; }
    if (session.state === 'revoked') {
      send(res, 200, { ok: true, session_id: sessionId, already_revoked: true });
      return true;
    }
    const revoked = await agentAuth.revokeSessionForClient(session.client_app_id, sessionId);
    if (!revoked) { send(res, 409, { error: 'Agent Session 状态已变化，请刷新后重试' }); return true; }
    await deps.stateStore.appendAudit({
      ts: deps.now(), job_id: '-', request_id: 'agent-client-admin', event: 'agent_session_admin_revoked',
      detail: { session_id: sessionId, client_app_id: session.client_app_id, by: actorOf(principal) },
    }).catch(() => undefined);
    send(res, 200, { ok: true, session_id: sessionId, revoked: true });
    return true;
  }

  return false;
}
