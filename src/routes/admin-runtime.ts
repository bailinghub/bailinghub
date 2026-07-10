// 后台运行面 API：任务、会话、审批、执行器在线、死信重投、状态与审计。
// 这里不承载项目/路由/凭证等配置 CRUD，避免 admin.ts 成为所有后台能力的巨型分发器。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EngineRuntime } from '../app/engine';
import { send } from '../app/http';
import { redactValue, redactionSummary } from '../core/runtime/redaction-runtime';
import { renderDebugReport } from '../core/runtime/debug-report';
import { buildJobTrace } from '../core/runtime/trace-runtime';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { Principal } from '../app/auth';
import type { ChannelMessage, ChannelSendResult } from '../app/channels';

export type AdminChannelSender = (channelName: string, recipient: string, message: string | ChannelMessage) => Promise<ChannelSendResult>;

function textPreview(v: unknown, limit = 2000): string | null {
  if (v == null) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > limit ? `${s.slice(0, limit)}...[truncated ${s.length - limit} chars]` : s;
}

function routeConfigSnapshot(route: any): Record<string, unknown> | null {
  if (!route) return null;
  return {
    route_key: route.route_key,
    name: route.name,
    enabled: route.enabled,
    target: route.target,
    profile: route.profile,
    project: route.project ?? null,
    session_policy: route.session_policy,
    audience: route.audience ?? null,
    knowledge: route.knowledge ?? null,
    tools: route.tools ?? null,
    delivery: route.delivery ?? null,
    memory: route.memory ?? null,
    budget: route.budget ?? null,
    retry: route.retry ?? null,
  };
}

function approvalSnapshot(a: any): Record<string, unknown> {
  return {
    id: a.id,
    job_id: a.job_id,
    request_id: a.request_id,
    tool: a.tool,
    status: a.status,
    scope: a.scope,
    policy: a.policy,
    reason: a.reason,
    summary: a.summary,
    decided_by: a.decided_by ?? null,
    created_at: a.created_at,
    decided_at: a.decided_at ?? null,
  };
}

function messageSnapshot(m: any): Record<string, unknown> {
  return {
    id: m.id,
    thread_id: m.thread_id,
    job_id: m.job_id ?? null,
    direction: m.direction,
    channel: m.channel,
    principal_id: m.principal_id,
    content_preview: textPreview(m.content, 1200),
    created_at: m.created_at,
  };
}

function buildDebugDiagnosis(input: {
  job: any;
  trace: ReturnType<typeof buildJobTrace>;
  approvals: any[];
  deliveryDlq: any[];
  currentRoute: any;
}): Array<{ severity: 'error' | 'warning' | 'info'; code: string; title: string; detail: string; next_action?: string }> {
  const out: Array<{ severity: 'error' | 'warning' | 'info'; code: string; title: string; detail: string; next_action?: string }> = [];
  const { job, trace, approvals, deliveryDlq, currentRoute } = input;
  const now = Date.now();
  const runAfterMs = job.run_after ? new Date(job.run_after).getTime() : 0;
  const leaseMs = job.lease_until ? new Date(job.lease_until).getTime() : 0;
  const lastError = [...trace.events].reverse().find((e) => e.severity === 'error');
  const pendingApproval = approvals.find((a) => a.status === 'pending');

  if (job.status === 'queued') {
    if (runAfterMs && runAfterMs > now) {
      out.push({ severity: 'info', code: 'queued_delayed', title: '任务正在等待延迟调度', detail: `run_after=${job.run_after}`, next_action: '等待退避时间到达；若这是非预期延迟，检查 retry/backoff 配置。' });
    } else if (job.thread_id) {
      out.push({ severity: 'warning', code: 'queued_thread_fifo', title: '任务仍在队列，可能受同 thread 串行约束影响', detail: `thread_id=${job.thread_id}`, next_action: '到「执行器 → 调度租约」查看该 thread 是否有在途任务阻塞队头。' });
    } else {
      out.push({ severity: 'warning', code: 'queued_waiting_claim', title: '任务等待执行器或本地调度认领', detail: `target=${job.target ?? '(unknown)'}`, next_action: '检查目标是否启用、执行器是否在线、队列是否积压。' });
    }
  }
  if ((job.status === 'running' || job.status === 'dispatched') && leaseMs) {
    if (leaseMs < now) {
      out.push({ severity: 'error', code: 'lease_expired', title: '任务租约已过期', detail: `lease_until=${job.lease_until}`, next_action: '检查执行器是否离线；等待 reaper 回队或手动排查该 executor。' });
    } else {
      out.push({ severity: 'info', code: 'lease_active', title: '任务租约有效', detail: `lease_until=${job.lease_until}`, next_action: '若长时间不收尾，检查执行器日志和目标超时配置。' });
    }
  }
  if (job.status === 'error' || job.status === 'rejected') {
    out.push({
      severity: 'error',
      code: job.status === 'rejected' ? 'job_rejected' : 'job_error',
      title: job.status === 'rejected' ? '任务被策略拒绝' : '任务执行失败',
      detail: job.error ?? lastError?.summary ?? '无错误摘要',
      next_action: lastError ? `查看 trace 事件 ${lastError.event} 的 detail。` : '查看 job.error 和执行器日志。',
    });
  }
  if (pendingApproval) {
    out.push({ severity: 'warning', code: 'approval_pending', title: '存在待处理审批意图', detail: `approval_id=${pendingApproval.id} tool=${pendingApproval.tool}`, next_action: '到「审批意图」处理，或确认业务侧审批回调是否已承接。' });
  }
  if (deliveryDlq.length) {
    out.push({ severity: 'error', code: 'delivery_dlq', title: '存在送达死信', detail: `${deliveryDlq.length} 条送达最终失败`, next_action: '到「送达死信」查看失败原因，修复渠道后重投。' });
  }
  if (job.dispatch?.route_key && !currentRoute) {
    out.push({ severity: 'warning', code: 'route_missing_now', title: '当前配置中找不到该任务使用的路由', detail: `route_key=${job.dispatch.route_key}`, next_action: '确认路由是否被删除；排障以 job_snapshot 为准。' });
  } else if (currentRoute && currentRoute.enabled === false) {
    out.push({ severity: 'warning', code: 'route_disabled_now', title: '该任务使用的路由当前已停用', detail: `route_key=${currentRoute.route_key}`, next_action: '确认这是预期停用，或重新启用路由后重试。' });
  }
  if (trace.summary.error_count && lastError && !out.some((d) => d.code === 'job_error')) {
    out.push({ severity: 'error', code: 'trace_error_event', title: 'Trace 中存在错误事件', detail: `${lastError.event}: ${lastError.summary || lastError.title}`, next_action: '展开该错误事件 detail，定位工具、送达或上下文装配失败原因。' });
  }
  if (!out.length) {
    out.push({ severity: 'info', code: 'no_obvious_issue', title: '未发现明确阻断项', detail: '任务状态、租约、审批、送达死信未显示明显异常。', next_action: '继续查看 trace 时间线和模型/工具返回内容。' });
  }
  return out;
}

export interface AdminRuntimeApiDeps {
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  now: () => string;
  isPaused: () => boolean;
  queueStats: () => unknown;
  channelSend: AdminChannelSender;
  engineRuntime: Pick<EngineRuntime, 'requeueForRerun'>;
}

export async function handleAdminRuntimeApiFor(
  deps: AdminRuntimeApiDeps,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  principal: Principal,
): Promise<boolean> {
  if (!deps.configStore) return false;
  const configStore = deps.configStore;
  const stateStore = deps.stateStore;

  async function tracePayload(jobId: string): Promise<Record<string, unknown> | null> {
    const job = await stateStore.getJob(jobId);
    if (!job) return null;
    const routeKey = String(job.dispatch?.route_key ?? '').trim();
    const [rawInput, audit, approvals, messages, deliveryDlq, currentRoute] = await Promise.all([
      configStore.conversations.rawInputForJob(jobId).catch(() => null),
      configStore.observability.auditForJob(jobId),
      configStore.approvals.forJob(jobId),
      configStore.conversations.messagesForJob(jobId),
      configStore.deliveryDlq.listByParentJob(jobId, true, 100).catch(() => []),
      routeKey ? configStore.routes.get(routeKey).catch(() => null) : Promise.resolve(null),
    ]);
    const jobWithRaw = { ...job, raw_input: rawInput };
    const trace = buildJobTrace({ job, audit, approvals, messages });
    const dispatchSnapshot = {
      status: job.status,
      target: job.target ?? null,
      profile: job.profile,
      project: job.project,
      route_key: routeKey || null,
      route_name: job.dispatch?.route_name ?? null,
      run_after: job.run_after ?? null,
      claimed_at: job.claimed_at ?? null,
      lease_until: job.lease_until ?? null,
      executor_id: job.executor_id ?? null,
      dispatched_at: job.dispatched_at ?? null,
      attempts: job.attempts ?? 0,
      has_claim_token: !!job.claim_token,
      updated_at: job.updated_at,
    };
    const debugBundle = redactValue({
      kind: 'bailing-job-debug-bundle',
      version: 1,
      generated_at: new Date().toISOString(),
      redaction: {
        ...redactionSummary(),
        note: '凭证、令牌、密钥和常见个人信息会在排障包内脱敏；原始 job/trace 本体仍仅面向授权后台查看。',
      },
      identifiers: {
        job_id: job.job_id,
        request_id: job.request_id,
        client_app_id: job.client_app_id ?? null,
        thread_id: job.thread_id ?? null,
        route_key: routeKey || null,
        principal_id: (job.metadata?.principal as any)?.id ?? job.metadata?.principal_id ?? null,
      },
      principal: job.metadata?.principal ?? null,
      dispatch: dispatchSnapshot,
      route: {
        current_exists: !!currentRoute,
        current: routeConfigSnapshot(currentRoute),
        job_snapshot: {
          target_config: job.dispatch?.target_config ?? null,
          delivery: job.dispatch?.delivery ?? null,
          retry: job.dispatch?.retry ?? null,
          tools: job.dispatch?.tools ?? null,
          memory: job.dispatch?.memory ?? null,
          kb_refs: job.dispatch?.kb_refs ?? [],
          user_images: job.dispatch?.user_images ?? [],
          user_audio: job.dispatch?.user_audio ?? [],
          user_files: job.dispatch?.user_files ?? [],
        },
      },
      outcome: {
        status: job.status,
        error: job.error ?? null,
        usage: job.usage ?? null,
        result_preview: textPreview(job.result ?? job.report ?? job.raw_result, 2000),
      },
      counts: {
        audit_events: trace.events.length,
        approvals: approvals.length,
        messages: messages.length,
        delivery_dlq: deliveryDlq.length,
        trace_errors: trace.summary.error_count,
        trace_warnings: trace.summary.warning_count,
      },
      approvals: approvals.map(approvalSnapshot),
      delivery_dlq: deliveryDlq,
      messages: messages.map(messageSnapshot),
      trace: trace.summary,
      events: trace.events,
      diagnosis: buildDebugDiagnosis({ job, trace, approvals, deliveryDlq, currentRoute }),
      raw_input_preview: textPreview(rawInput, 2000),
    });
    return {
      job: jobWithRaw,
      trace,
      approvals,
      messages,
      lookup: {
        job_id: job.job_id,
        request_id: job.request_id,
        client_app_id: job.client_app_id ?? null,
        thread_id: job.thread_id ?? null,
          route_key: job.dispatch?.route_key ?? null,
          principal: job.metadata?.principal ?? null,
        },
      debug_bundle: debugBundle,
      debug_report: renderDebugReport(debugBundle as Record<string, any>),
    };
  }

  // ---- 送达死信队列：最终失败的送达可查可重投（闭环 delivery_failed_* 告警）----
  if (path === '/admin/api/delivery-dlq' && method === 'GET') {
    const u = new URL(req.url ?? '', 'http://x');
    send(res, 200, { items: await configStore.deliveryDlq.list(u.searchParams.get('all') === '1', Number(u.searchParams.get('limit') ?? 100)) });
    return true;
  }
  const mDlqResend = path.match(/^\/admin\/api\/delivery-dlq\/(\d+)\/resend$/);
  if (mDlqResend && method === 'POST') {
    const id = Number(mDlqResend[1]);
    const d = await configStore.deliveryDlq.get(id);
    if (!d) { send(res, 404, { error: '死信不存在' }); return true; }
    if (d.resolved) { send(res, 200, { ok: true, note: '已处理过，未重复重投' }); return true; }
    const sent = await deps.channelSend(d.channel, d.recipient, d.content).catch((e) => ({ ok: false as const, error: String(e) }));
    if (sent.ok) await configStore.deliveryDlq.resolve(id);
    await stateStore.appendAudit({ ts: deps.now(), job_id: '-', request_id: 'delivery-dlq', event: sent.ok ? 'dlq_resend_ok' : 'dlq_resend_failed', detail: { id, channel: d.channel, to: d.recipient, ...(sent.ok ? {} : { error: (sent as { error?: string }).error }) } }).catch(() => undefined);
    send(res, sent.ok ? 200 : 502, sent.ok ? { ok: true } : { ok: false, error: (sent as { error?: string }).error ?? '重投失败' });
    return true;
  }
  const mDlqResolve = path.match(/^\/admin\/api\/delivery-dlq\/(\d+)\/resolve$/);
  if (mDlqResolve && method === 'POST') {
    await configStore.deliveryDlq.resolve(Number(mDlqResolve[1]));
    send(res, 200, { ok: true });
    return true;
  }

  if (path === '/admin/api/runs' && method === 'GET') {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    send(res, 200, await configStore.observability.listRecentJobs(Number(q.get('limit')) || 50, Number(q.get('offset')) || 0));
    return true;
  }

  if (path === '/admin/api/runs/trace' && method === 'GET') {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const jobId = String(q.get('job_id') ?? '').trim();
    if (/^[0-9a-f-]{36}$/i.test(jobId)) {
      const payload = await tracePayload(jobId);
      if (!payload) { send(res, 404, { error: 'job 不存在' }); return true; }
      send(res, 200, payload);
      return true;
    }
    const requestId = String(q.get('request_id') ?? '').trim();
    const clientAppId = String(q.get('client_id') ?? q.get('client_app_id') ?? '').trim();
    const principalId = String(q.get('principal_id') ?? '').trim();
    const threadRaw = String(q.get('thread_id') ?? '').trim();
    const threadId = threadRaw && /^\d+$/.test(threadRaw) ? Number(threadRaw) : undefined;
    const matches = await configStore.observability.findJobs({
      ...(requestId ? { requestId } : {}),
      ...(clientAppId ? { clientAppId } : {}),
      ...(principalId ? { principalId } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      limit: Number(q.get('limit')) || 20,
    });
    if (matches.length === 1 && q.get('list') !== '1') {
      const payload = await tracePayload(matches[0]!.job_id);
      if (payload) { send(res, 200, { ...payload, matches }); return true; }
    }
    send(res, 200, { matches, count: matches.length });
    return true;
  }

  if (path === '/admin/api/dispatch-status' && method === 'GET') {
    send(res, 200, await configStore.observability.dispatchStatus());
    return true;
  }

  // 成本可观测（先行）：近 N 天花费聚合（默认 30 天）。只读，不设预算硬闸——先让花费看得见。
  if (path === '/admin/api/cost' && method === 'GET') {
    const days = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('days')) || 30;
    send(res, 200, await configStore.observability.costSummary(days));
    return true;
  }

  // 会话视图（调度台「会话」Tab）：列线索 / 取单会话全量（消息总账+对齐的 job_id，执行轨迹复用 /runs/:job 接口懒拉）
  if (path === '/admin/api/threads' && method === 'GET') {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    send(res, 200, await configStore.conversations.listRecentThreads(Number(q.get('limit')) || 80, Number(q.get('offset')) || 0));
    return true;
  }
  const mThread = path.match(/^\/admin\/api\/threads\/(\d+)$/);
  if (mThread && method === 'GET') {
    const d = await configStore.conversations.threadDetail(Number(mThread[1]));
    if (!d) { send(res, 404, { error: '会话不存在' }); return true; }
    send(res, 200, d);
    return true;
  }

  // 任务详情 / 审计时间线 / 重跑
  const mRun = path.match(/^\/admin\/api\/runs\/([0-9a-f-]{36})(\/audit|\/rerun|\/trace)?$/);
  if (mRun) {
    const jobId = mRun[1]!;
    const job = await stateStore.getJob(jobId);
    if (!job) { send(res, 404, { error: 'job 不存在' }); return true; }
    if (method === 'GET' && !mRun[2]) {
      // raw_input = 未装配的原始触发输入（总账 in 消息），供审计区分"用户发了啥"与"我们组装成的 input"；无总账时前端回落 input_preview
      const rawInput = await configStore.conversations.rawInputForJob(jobId).catch(() => null);
      send(res, 200, { ...job, raw_input: rawInput });
      return true;
    }
    if (method === 'GET' && mRun[2] === '/audit') {
      send(res, 200, await configStore.observability.auditForJob(jobId));
      return true;
    }
    if (method === 'GET' && mRun[2] === '/trace') {
      // 单 job 全链聚合：把散在 job / 审计 / 工具审批 / 总账 4 处的回放素材一次取齐（控制台原先要 2+ 次调用拼）。
      send(res, 200, await tracePayload(jobId));
      return true;
    }
    if (method === 'POST' && mRun[2] === '/rerun') {
      if (job.status === 'queued' || job.status === 'running' || job.status === 'dispatched') {
        send(res, 400, { error: `任务在途（${job.status}），无需重跑` });
        return true;
      }
      await deps.engineRuntime.requeueForRerun(job, principal.kind === 'admin' ? principal.username ?? 'token' : '?', 'console');
      send(res, 200, { ok: true, job_id: jobId, status: 'queued' });
      return true;
    }
  }

  // ---- 工具审批（确认车道 B：批准后自动重跑；批准范围锁定当时那个调用快照）----
  if (path === '/admin/api/tool-approvals' && method === 'GET') {
    const status = new URL(req.url ?? '/', 'http://x').searchParams.get('status') ?? 'pending';
    send(res, 200, await configStore.approvals.list(status === 'all' ? undefined : status));
    return true;
  }
  const mApproval = path.match(/^\/admin\/api\/tool-approvals\/(\d+)\/(approve|deny)$/);
  if (mApproval && method === 'POST') {
    const id = Number(mApproval[1]);
    const action = mApproval[2] as 'approve' | 'deny';
    const appr = await configStore.approvals.get(id);
    if (!appr) { send(res, 404, { error: '审批单不存在' }); return true; }
    if (appr.status !== 'pending') { send(res, 400, { error: `审批单已是 ${appr.status}，不可重复裁决` }); return true; }
    const by = principal.kind === 'admin' ? principal.username ?? 'token' : '?';
    if (!(await configStore.approvals.decide(id, action === 'approve' ? 'approved' : 'denied', by))) {
      send(res, 409, { error: '审批单状态已变化，请刷新后重试' });
      return true;
    }
    await stateStore.appendAudit({
      ts: deps.now(), job_id: appr.job_id, request_id: appr.request_id,
      event: action === 'approve' ? 'tool_approved' : 'tool_denied',
      detail: { approval_id: id, tool: appr.tool, scope: appr.scope, by, policy: appr.policy, reason: appr.reason, summary: appr.summary },
    });
    // 批准 → 自动重跑原任务（任务在途则不动：运行中会自然消费批准单）
    let rerun = false;
    if (action === 'approve') {
      const job = await stateStore.getJob(appr.job_id);
      if (job && (job.status === 'done' || job.status === 'error' || job.status === 'rejected')) {
        await deps.engineRuntime.requeueForRerun(job, by, `approval_${id}`);
        rerun = true;
      }
    }
    send(res, 200, { ok: true, id, status: action === 'approve' ? 'approved' : 'denied', rerun });
    return true;
  }

  // 执行器富列表（控制台「执行器」页）：在线状态 + 最后心跳 + 声明的 targets + 自报能力（profiles/claude 版本/标签）。
  // 路由/目标的「服务池与覆盖度」由前端拿这份 + /targets + /routes 做 join 计算（中枢不替前端预算，保持后端简单）。
  if (path === '/admin/api/executors' && method === 'GET') {
    const list = (await configStore.executors.list().catch(() => [])).map((e) => ({
      ...e, online: Date.now() - new Date(e.last_seen_at).getTime() < 2 * 60_000, // 与 /status 同口径：2 分钟无心跳=离线
    }));
    send(res, 200, list);
    return true;
  }
  // 注销执行器（退役/换名/selftest 清场）：删心跳记录，不再参与离线告警
  if (path.startsWith('/admin/api/executors/') && method === 'DELETE') {
    await configStore.executors.delete(decodeURIComponent(path.slice('/admin/api/executors/'.length)));
    send(res, 200, { ok: true });
    return true;
  }

  // 配置变更审计（谁在什么时候改了什么）
  if (path === '/admin/api/config-audit' && method === 'GET') {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    send(res, 200, await configStore.observability.recentConfigAudit(Number(q.get('limit')) || 100, Number(q.get('offset')) || 0));
    return true;
  }

  // 系统状态（执行器在线/队列/暂停位）：所有登录角色可见
  if (path === '/admin/api/status' && method === 'GET') {
    const executors = (await configStore.executors.list().catch(() => [])).map((e) => ({
      ...e, online: Date.now() - new Date(e.last_seen_at).getTime() < 2 * 60_000, // 执行器 ~12s 一轮 claim，2 分钟没动静=离线
    }));
    send(res, 200, { paused: deps.isPaused(), queue: deps.queueStats(), executors });
    return true;
  }

  return false;
}
