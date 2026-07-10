// 执行器派活通道：Mac 等远端执行器出站长轮询认领(claim)→ 干活 → 回报(result)。含心跳节流落库 + 工作项装配。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readBody, send } from '../app/http';
import type { EngineRuntime } from '../app/engine';
import type { ToolProxyDeps } from '../app/tool-proxy';
import { isRemoteExecutorTarget } from '../core/targets/registry';
import type { Principal } from '../app/auth';
import type { ExecutorCapabilities, Job } from '../core/contracts/types';
import { routeRetryConfig } from '../core/config/route-config';
import type { RuntimeActor, RuntimeContext, RuntimeSource } from '../core/edition';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { ToolIndexService } from '../services/tools-index';

// ---- 执行器派活通道（Mac 出站长轮询认领 + 回报）----

// 执行器心跳：claim 即心跳，30s 节流落库（执行器 ~12s 一轮，不值得每轮写库）。
// capabilities 随每轮 claim 带上（执行器自报能跑哪些 profile/claude 版本），一并落库供控制台展示+覆盖度校验。
const executorTouchAt = new Map<string, number>();
function touchExecutorThrottled(config: ConfigStoreContract | null, executorId: string, targets: string[], capabilities?: ExecutorCapabilities | null): void {
  const cfgStore = config;
  if (!cfgStore) return;
  const last = executorTouchAt.get(executorId) ?? 0;
  if (Date.now() - last < 30_000) return;
  executorTouchAt.set(executorId, Date.now());
  void cfgStore.executors.touch(executorId, targets, capabilities).catch(() => { /* 观测数据，失败不影响派活 */ });
}
// 执行器令牌的 last_seen 心跳（令牌管理页观测用，30s 节流，与上面的执行器心跳分开键）
const tokenTouchAt = new Map<string, number>();
const EXECUTOR_JOB_LEASE_MS = 4 * 60 * 1000;
function touchTokenThrottled(config: ConfigStoreContract | null, name: string): void {
  const cfgStore = config;
  if (!cfgStore) return;
  const last = tokenTouchAt.get(name) ?? 0;
  if (Date.now() - last < 30_000) return;
  tokenTouchAt.set(name, Date.now());
  void cfgStore.executorTokens.touch(name).catch(() => { /* 观测数据 */ });
}

interface RuntimeContextInput {
  source: RuntimeSource;
  requestId: string;
  principal?: Principal | null;
  actor?: RuntimeActor;
}

export interface ExecutorApiDeps {
  cfg: AppConfig;
  toolIndex: ToolIndexService | null;
  isPaused: () => boolean;
  runtimeContextFor: (input: RuntimeContextInput) => Promise<RuntimeContext>;
  runtimeStoresFor: (ctx: RuntimeContext) => { state: RuntimeStateStore; config: ConfigStoreContract | null };
  resolveProjectPathFor: (config: ConfigStoreContract | null, name: string) => Promise<string | null>;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  toolsForWorkItemFor: (deps: ToolProxyDeps, job: Job) => Promise<Record<string, unknown> | null>;
  engineForContext: (ctx: RuntimeContext) => Pick<EngineRuntime, 'finish'>;
}

async function executorRuntime(deps: ExecutorApiDeps, input: RuntimeContextInput) {
  const ctx = await deps.runtimeContextFor(input);
  return { ctx, ...deps.runtimeStoresFor(ctx) };
}

/** 把内部 job 整理成执行器需要的工作项（含本机绝对目录、target_config、会话）。 */
function toWorkItem(job: Job, projectPath: string | null): Record<string, unknown> {
  const d = job.dispatch ?? {};
  return {
    job_id: job.job_id,
    request_id: job.request_id,
    target: job.target,
    profile: job.profile,
    project: job.project,
    project_path: projectPath,
    input: job.input ?? '',
    metadata: job.metadata,
    source: job.source,
    target_config: d.target_config ?? {},
    user_images: d.user_images ?? [],
    user_audio: d.user_audio ?? [],
    user_files: d.user_files ?? [],
    session: { sessionId: job.session_id ?? randomUUID(), isContinue: !!d.is_continue },
    claim_token: job.claim_token, // 本次派发的一票一用凭证：执行器回报时原样带回，中枢据此拒收"被重排后原执行器的迟到回报"
  };
}

export async function handleExecutorClaimFor(deps: ExecutorApiDeps, req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
  const body = (await readBody(req)) as Record<string, unknown>;
  const executorId = String(body['executor_id'] ?? 'unknown');
  const { state: store, config: cfgStore } = await executorRuntime(deps, { source: 'executor', requestId: String(body['request_id'] ?? `executor_claim_${randomUUID()}`), principal });
  const want = Array.isArray(body['targets']) ? (body['targets'] as unknown[]).map(String) : [];
  // 令牌授权闸：执行器令牌只能认领其 allowed_targets 内的目标（["*"]=全部）；管理员 token 不限。
  const allowed = principal.kind === 'executor' ? principal.token.allowed_targets : ['*'];
  const allows = (t: string): boolean => allowed.includes('*') || allowed.includes(t);
  const registered = want.filter(isRemoteExecutorTarget);
  const claimable = registered.filter(allows);
  if (!claimable.length) {
    const blocked = registered.filter((t) => !allows(t));
    send(res, blocked.length ? 403 : 400, {
      error: blocked.length
        ? `执行器令牌无权认领：${blocked.join(',')}（该令牌可认领 ${allowed.join(',') || '(无)'}，到控制台「执行器」调整）`
        : 'targets 必填，且须为「调度目标」里注册的执行器类目标',
    });
    return;
  }
  const caps = body['capabilities'] && typeof body['capabilities'] === 'object' ? (body['capabilities'] as ExecutorCapabilities) : null;
  touchExecutorThrottled(cfgStore, executorId, claimable, caps); // 心跳：每轮 claim 都算活着（30s 节流落库）
  void store.extendExecutorLeases(executorId, EXECUTOR_JOB_LEASE_MS).catch(() => { /* 续租失败不影响本轮认领响应，下轮/reaper 会兜底 */ });
  if (principal.kind === 'executor') touchTokenThrottled(cfgStore, principal.token.name); // 令牌侧 last_seen
  const waitMs = Math.min(Math.max(Number(body['wait_ms'] ?? 25000) || 0, 0), 55000);
  const deadline = Date.now() + waitMs;

  let closed = false;
  req.on('close', () => { closed = true; });

  while (!closed) {
    if (deps.isPaused()) { send(res, 200, { job: null, paused: true }); return; }
    const job = await store.claimNextJob(claimable, executorId, EXECUTOR_JOB_LEASE_MS);
    if (job) {
      const projectPath = job.project ? await deps.resolveProjectPathFor(cfgStore, job.project) : null;
      // 统一工具面：路由挂了 tools → 认领件附工具清单 + 任务级 tool_token（执行器大脑经 /jobs/:id/tools/invoke 与 llm 共用同一治理面）
      const tools = await deps.toolsForWorkItemFor({ cfg: deps.cfg, configStore: cfgStore, stateStore: store, toolIndex: deps.toolIndex, now: deps.now, sleep: deps.sleep }, job);
      await store.appendAudit({ ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event: 'dispatched', detail: { executor_id: executorId, target: job.target, ...(tools ? { tools: ((tools['defs'] ?? tools['catalog']) as unknown[]).length, tools_mode: tools['mode'] } : {}) } });
      if (!closed) send(res, 200, { job: { ...toWorkItem(job, projectPath), ...(tools ? { tools } : {}) } });
      return;
    }
    if (Date.now() >= deadline) break;
    await deps.sleep(1200);
  }
  if (!closed) send(res, 200, { job: null });
}

/** 独立心跳：与 claim 解耦的存活上报。执行器跑长任务时 claim 循环被阻塞、不再 claim，靠这条按 ~30s 持续刷新
 *  last_seen，使「离线判定 / 滞留任务重排」都按"执行器是否还活着"判，而不是拿任务时长瞎猜（长任务是常态）。 */
export async function handleExecutorHeartbeatFor(deps: ExecutorApiDeps, req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
  const body = (await readBody(req)) as Record<string, unknown>;
  const executorId = String(body['executor_id'] ?? 'unknown');
  const { state: store, config: cfgStore } = await executorRuntime(deps, { source: 'executor', requestId: String(body['request_id'] ?? `executor_heartbeat_${executorId}`), principal });
  const want = Array.isArray(body['targets']) ? (body['targets'] as unknown[]).map(String) : [];
  const allowed = principal.kind === 'executor' ? principal.token.allowed_targets : ['*'];
  const allows = (t: string): boolean => allowed.includes('*') || allowed.includes(t);
  const claimable = want.filter(isRemoteExecutorTarget).filter(allows);
  const caps = body['capabilities'] && typeof body['capabilities'] === 'object' ? (body['capabilities'] as ExecutorCapabilities) : null;
  // 心跳自带节奏（~30s），无需再节流——直接落库保证 last_seen 始终新鲜；写库失败不影响存活语义，下一拍再来。
  void cfgStore?.executors.touch(executorId, claimable, caps).catch(() => { /* 观测数据，失败不影响 */ });
  void store.extendExecutorLeases(executorId, EXECUTOR_JOB_LEASE_MS).catch(() => { /* 续租失败不影响心跳响应 */ });
  if (principal.kind === 'executor') touchTokenThrottled(cfgStore, principal.token.name);
  send(res, 200, { ok: true });
}

export async function handleExecutorResultFor(deps: ExecutorApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as Record<string, unknown>;
  const jobId = String(body['job_id'] ?? '');
  if (!jobId) { send(res, 400, { error: 'job_id 必填' }); return; }
  const { ctx, state: store } = await executorRuntime(deps, {
    source: 'executor',
    requestId: jobId,
    actor: { kind: 'executor', id: String(body['executor_id'] ?? 'result'), roles: ['executor'] },
  });
  const engine = deps.engineForContext(ctx);
  const job = await store.getJob(jobId);
  if (!job) { send(res, 404, { error: 'job 不存在' }); return; }
  if (job.status !== 'dispatched') { send(res, 200, { ok: true, status: job.status, note: 'job 非 dispatched，已忽略（幂等）' }); return; }
  // 过期回报防护：任务被重排后会再次 dispatched（claim_token 已换）。原执行器迟到的回报带的是旧 token，
  // 必须拒收——否则会把陈旧结果错记成新执行器的（结果错配/副作用重复）。执行器未回传 token 时退回仅状态校验。
  const sentToken = body['claim_token'] ? String(body['claim_token']) : '';
  if (sentToken && job.claim_token && sentToken !== job.claim_token) {
    send(res, 200, { ok: true, status: job.status, note: 'claim_token 不匹配（任务已被重新派发给其它执行器），本次为过期回报，已忽略' });
    return;
  }

  const ok = body['ok'] !== false && !body['error'];

  // 执行器侧失败重排：投递任务内置重试（通知网关重启等瞬时故障常见）；其余按路由 retry 快照。
  // 重排=回 queued 等下一轮认领（认领轮询自然形成秒级退避），不做终态。
  if (!ok) {
    const builtinDeliveryMax = job.source === 'delivery' ? 2 : 0;
    const retry = routeRetryConfig(job.dispatch?.retry);
    const max = Math.max(retry.max, builtinDeliveryMax);
    const attempt = job.attempts ?? 0;
    if (attempt < max) {
      const patch: Partial<Job> = { status: 'queued', attempts: attempt + 1, executor_id: undefined, claimed_at: undefined, lease_until: undefined, dispatched_at: undefined, claim_token: undefined };
      // 新会话任务重派必须换新 session_id：复用同一 id 让 claude `--session-id`/`--resume` 自爆 already-in-use（失败的那次
      // 可能已建了半个会话）。续聊(passthrough，is_continue)任务保留业务指定的会话 id 不动——那是业务要续的真实上下文。
      if (!job.dispatch?.is_continue) patch.session_id = randomUUID();
      await store.updateJob(job.job_id, patch);
      await store.appendAudit({
        ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event: 'retry_scheduled',
        detail: { attempt: attempt + 1, max, via: 'executor', new_session: !job.dispatch?.is_continue, error: String(body['error'] ?? '').slice(0, 200) },
      });
      send(res, 200, { ok: true, retried: true });
      return;
    }
  }

  await engine.finish(job, {
    status: ok ? 'done' : 'error',
    session_id: (body['session_id'] as string) ?? job.session_id,
    usage: body['usage'] as Job['usage'],
    result: (body['output'] as Record<string, unknown>) ?? {},
    error: body['error'] ? String(body['error']) : undefined,
  });
  send(res, 200, { ok: true });
}
