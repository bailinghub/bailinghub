// 入口落单运行时：把合法入口请求变成 Job，并决定本轮是等待远端执行器还是进入中枢本地串行道。
// 本模块不依赖 runtime 单例；engine 负责把 store、ledger、知识服务与目标注册表判断传入。
import { randomUUID } from 'node:crypto';
import { assembleDispatchContext, sanitizeUserInput, type DispatchContextResult } from './context-runtime';
import { type KnowledgeServiceLike } from './knowledge-runtime';
import { resolveMemoryConfig } from './memory';
import { type MemoryStoreLike } from './memory-runtime';
import type { AuditEntry, Job, Route, SessionTarget } from '../contracts/types';

/** launchJob 的入参：触发面（/run、/chat）各自做完闸门与会话解析后交到这里。 */
export interface LaunchSpec {
  requestId: string;
  fullInput: string;                  // 原始输入（总账与 preview 记这个，不记装配后的）
  route: Route | null;
  routeKey: string | null;
  target: string;
  project: string | null;
  projectPath: string | null;
  profileName: string;
  permission?: string;                // 权限档：readonly|readwrite|full（只读/可写/全开）。空=不加限制。派发时以提示词前置指导执行器。
  source: string;
  clientAppId?: string;
  metadata: Record<string, unknown>;
  callbackUrl?: string;
  session: SessionTarget;
  threadScope: string;                // ''=不记总账
  principalId: string | null;
  channel: string;                    // 总账入站消息的渠道标识（接入方 app_id / 'admin' / 'chat:<entry>'）
}

export interface LaunchStateStoreLike {
  createJob(job: Job): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;
  countInflightByThread(threadId: number): Promise<number>;
}

export interface LaunchLedgerStoreLike extends MemoryStoreLike {
  resolveThread(routeKey: string, scopeKey: string, principalId?: string | null): Promise<number>;
  appendMessage(m: {
    thread_id: number;
    direction: 'in' | 'out';
    channel: string;
    principal_id?: string | null;
    job_id?: string | null;
    content: string;
  }): Promise<void>;
}

export interface LaunchRuntimeDeps {
  store: LaunchStateStoreLike;
  ledger?: LaunchLedgerStoreLike | null;
  knowledgeService?: KnowledgeServiceLike | null;
  now: () => string;
  isRemoteExecutorTarget: (target: string) => boolean;
  targetIsStateless: (target: string) => boolean;
  threadInflightQuota?: number;
}

export interface LaunchRuntimeResult {
  job: Job;
  isRemoteExecutor: boolean;
  threadId?: number;
  assemble: () => Promise<DispatchContextResult>;
}

// 会话级在途配额（背压）：同一会话(thread)在途任务(queued+running+dispatched)达此上限即拒绝新建。
export const DEFAULT_THREAD_INFLIGHT_QUOTA = 6;

function audit(deps: LaunchRuntimeDeps, requestId: string, event: string, detail: Record<string, unknown>, jobId = '-'): Promise<void> {
  return deps.store.appendAudit({ ts: deps.now(), job_id: jobId, request_id: requestId, event, detail });
}

export async function rejectLaunchJob(
  s: LaunchSpec,
  deps: Pick<LaunchRuntimeDeps, 'store' | 'now'>,
  input: { reason: string; error: string; detail?: Record<string, unknown>; threadId?: number },
): Promise<Job> {
  const rejected: Job = {
    job_id: randomUUID(), request_id: s.requestId, status: 'rejected',
    target: s.target, profile: s.profileName, project: s.project ?? '', source: s.source,
    client_app_id: s.clientAppId, thread_id: input.threadId, session_id: s.session.sessionId,
    input_preview: s.fullInput.slice(0, 200), input: sanitizeUserInput(s.fullInput),
    dispatch: { target_config: s.route?.target_config ?? {}, is_continue: s.session.isContinue, route_key: s.routeKey ?? undefined, route_name: s.route?.name },
    error: input.error, metadata: s.metadata, callback_url: s.callbackUrl, created_at: deps.now(), updated_at: deps.now(),
  };
  await deps.store.createJob(rejected);
  await deps.store.appendAudit({
    ts: deps.now(), job_id: rejected.job_id, request_id: rejected.request_id, event: 'rejected',
    detail: { reason: input.reason, ...(input.detail ?? {}) },
  });
  return rejected;
}

/**
 * 任务落地共用件：清洗输入 → 解析 thread → 背压 → 装配策略 → 建单审计。
 * 远端执行器目标会在建单前完成上下文装配；中枢内目标只返回 assemble 闭包，由 engine 放入会话串行道后执行。
 */
export async function launchJobRecord(s: LaunchSpec, deps: LaunchRuntimeDeps): Promise<LaunchRuntimeResult> {
  const quota = deps.threadInflightQuota ?? DEFAULT_THREAD_INFLIGHT_QUOTA;
  const safeUserInput = sanitizeUserInput(s.fullInput);
  const memCfg = resolveMemoryConfig(s.route?.memory as Record<string, unknown> | undefined);

  let threadId: number | undefined;
  if (s.route && deps.ledger && s.threadScope) {
    try {
      threadId = await deps.ledger.resolveThread(s.route.route_key, s.threadScope, s.principalId);
    } catch (e) {
      await audit(deps, s.requestId, 'ledger_error', { stage: 'resolve', error: String(e) });
    }
  }

  const isRemoteExecutor = deps.isRemoteExecutorTarget(s.target);
  const assemble = () => assembleDispatchContext({
    route: s.route,
    metadata: s.metadata,
    fullInput: s.fullInput,
    requestId: s.requestId,
    permission: s.permission,
    safeInput: safeUserInput,
    threadId,
    memory: memCfg,
    memoryEnabled: !!(s.route && s.threadScope && (deps.targetIsStateless(s.target) || !s.session.isContinue)),
    memoryStore: deps.ledger,
    knowledgeService: deps.knowledgeService,
    audit: (event, detail) => audit(deps, s.requestId, event, detail),
  });

  if (threadId && (await deps.store.countInflightByThread(threadId).catch(() => 0)) >= quota) {
    const rejected = await rejectLaunchJob(s, deps, {
      reason: 'thread_inflight_quota',
      error: `会话在途任务过多（≥${quota}），已拒绝本次，请等前面的处理完再发`,
      detail: { quota, thread_id: threadId },
      threadId,
    });
    return { job: rejected, isRemoteExecutor, threadId, assemble };
  }

  // 执行器任务：入队前同步装配（job.input 要带去远端执行器）。inhub 任务：延后到会话串行道内装配。
  const initial = isRemoteExecutor ? await assemble() : null;
  const baseDispatch: Record<string, unknown> = {
    target_config: s.route?.target_config ?? {}, is_continue: s.session.isContinue,
    delivery: s.route?.delivery, route_key: s.routeKey ?? undefined, route_name: s.route?.name, retry: s.route?.retry, tools: s.route?.tools,
    ...(memCfg.summary_enabled ? { memory: memCfg as unknown as Record<string, unknown> } : {}),
    ...(initial?.kbRefs ? { kb_refs: initial.kbRefs } : {}),
    ...(initial && initial.userImages.length ? { user_images: initial.userImages } : {}),
    ...(initial && initial.userAudio.length ? { user_audio: initial.userAudio } : {}),
    ...(initial && initial.userFiles.length ? { user_files: initial.userFiles } : {}),
  };
  const job: Job = {
    job_id: randomUUID(), request_id: s.requestId, status: 'queued',
    target: s.target, profile: s.profileName, project: s.project ?? '', source: s.source,
    client_app_id: s.clientAppId, thread_id: threadId, session_id: s.session.sessionId,
    input_preview: s.fullInput.slice(0, 200),
    input: initial ? initial.dispatchInput : safeUserInput,
    dispatch: baseDispatch as Job['dispatch'],
    metadata: s.metadata, callback_url: s.callbackUrl, created_at: deps.now(), updated_at: deps.now(),
  };
  await deps.store.createJob(job);
  await audit(deps, s.requestId, 'received', {
    target: s.target, project: s.project, profile: s.profileName,
    ...(s.permission ? { permission: s.permission } : {}),
    source: job.source, route: s.routeKey, client: s.channel, session: s.session.sessionId, continue: s.session.isContinue,
  }, job.job_id);

  // 总账记入站（记原始输入，不记装配后的；失败不阻塞）
  if (threadId && deps.ledger) {
    void deps.ledger.appendMessage({
      thread_id: threadId,
      direction: 'in',
      channel: s.channel,
      principal_id: s.principalId,
      job_id: job.job_id,
      content: s.fullInput,
    }).catch(() => { /* 总账故障可降级 */ });
  }

  if (isRemoteExecutor) {
    await audit(deps, s.requestId, 'awaiting_executor', { target: s.target }, job.job_id);
  }

  return { job, isRemoteExecutor, threadId, assemble };
}
