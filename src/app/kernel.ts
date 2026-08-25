import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { bootstrapInitialAdmin } from './admin-bootstrap';
import type { Principal } from './auth';
import { channelSendFor } from './channels';
import { createEngineRuntime } from './engine';
import { createBailingHttpServer } from './http-server';
import { normalizeHttpMountPath, now, send, serveConsoleFromRoot, sleep } from './http';
import { createOperationalMetricsEndpointFor } from './operational-metrics';
import { createOssEdition } from './oss-edition';
import { outboundRuntimeDepsFor, secretForJobWithDeps } from './outbound';
import { checkReadinessFor } from './readiness';
import { createRuntimeComposition } from './runtime-composition';
import { createRuntimeContextHelpers } from './runtime-context';
import {
  createManagedRuntimeMaintenanceFor,
  initializeRuntimeLifecycleFor,
  scheduleBootRecoveryFor,
  startRuntimeSchedulersFor,
  type ManagedRuntimeMaintenance,
  type RuntimeLifecycleDeps,
  type RuntimeSchedulers,
} from './runtime-lifecycle';
import { toolsForWorkItemFor } from './tool-proxy';
import { createRuntimeContext, type ConsoleCapabilities, type ScopeResolver } from '../core/edition';
import type { AppConfig } from '../core/config/config';
import type { Job } from '../core/contracts/types';
import { Queue } from '../core/platform/queue';
import type { LaunchSpec } from '../core/runtime/launch-runtime';
import { TargetRegistry } from '../core/targets/registry';
import type {
  BailingHubKernelV1,
  CreateBailingHubKernelInputV1,
  KernelLaunchRequestV1,
  KernelStandaloneServerV1,
} from '../kernel-api/v1/contracts';
import { handleAdminApiFor } from '../routes/admin';
import { handleApprovalDecisionFor } from '../routes/approvals';
import {
  handleChatConfigFor,
  handleChatEventsFor,
  handleChatFor,
  handleChatRateFor,
  handleChatThreadFor,
  handleChatUploadFor,
  serveChatDemoFor,
  type ChatApiDeps,
} from '../routes/chat';
import {
  handleExecutorClaimFor,
  handleExecutorHeartbeatFor,
  handleExecutorResultFor,
  ExecutorRuntimeState,
  type ExecutorApiDeps,
} from '../routes/executor';
import { handleKbIngestFor, handleKbIngestListFor, handleKbSearchFor } from '../routes/kb';
import { handlePrivateHttpFor, type PrivateHttpDeps } from '../routes/private';
import { handlePublicHttpFor } from '../routes/public';
import { handleRunFor, type RunApiDeps } from '../routes/run';
import { handleSendFor, type SendApiDeps } from '../routes/send';
import { handleWecomInboundFor, WecomRuntimeState, type WecomApiDeps } from '../routes/wecom';
import { WecomAccessTokenCache } from '../adapters/channels/wecom-api';
import { DemoDatasetService } from '../services/demo-dataset';

const timezoneClaims = new Map<string, number>();
const MAX_KERNEL_CLOSE_DRAIN_MS = 10 * 60_000;

function kernelLaunchRequestV1(spec: LaunchSpec): KernelLaunchRequestV1 {
  return Object.freeze({
    requestId: spec.requestId,
    routeKey: spec.routeKey,
    target: spec.target,
    project: spec.project,
    profileName: spec.profileName,
    permission: spec.permission,
    source: spec.source,
    clientAppId: spec.clientAppId,
    metadata: Object.freeze({ ...spec.metadata }),
    callbackUrl: spec.callbackUrl,
    session: Object.freeze({ ...spec.session }),
    threadScope: spec.threadScope,
    principalId: spec.principalId,
    channel: spec.channel,
    ...(spec.agentAttribution ? { agentAttribution: Object.freeze({ ...spec.agentAttribution }) } : {}),
  });
}

function claimProcessTimezone(cfg: AppConfig): () => void {
  const key = `${cfg.displayTz}\u0000${cfg.displayTzLabel}`;
  const conflicting = [...timezoneClaims.keys()].find((active) => active !== key);
  if (conflicting) {
    throw new Error('同一进程内的 BailingHub Kernel 必须使用相同 display_tz/display_tz_label；当前版本不支持实例级展示时区');
  }
  timezoneClaims.set(key, (timezoneClaims.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (timezoneClaims.get(key) ?? 1) - 1;
    if (next > 0) timezoneClaims.set(key, next);
    else timezoneClaims.delete(key);
  };
}

function assertInstanceKey(value: string): string {
  const key = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{1,127}$/.test(key)) {
    throw new Error('instanceKey 必须为 2-128 位字母、数字、点、冒号、中划线或下划线');
  }
  return key;
}

function kernelRuntimeConfig(input: AppConfig): AppConfig {
  if (input.runtimeRoot === undefined) return input;
  const rawRuntimeRoot = input.runtimeRoot.trim();
  if (!rawRuntimeRoot || !isAbsolute(rawRuntimeRoot)) {
    throw new Error('Kernel runtimeRoot 必须是非空绝对路径');
  }
  const runtimeRoot = resolve(rawRuntimeRoot);
  const normalized = runtimeRoot === input.runtimeRoot ? input : { ...input, runtimeRoot };
  // loadConfig resolves the historical default pause file under Core root.
  // When a Host later injects runtimeRoot, rebase that default automatically;
  // an explicit custom killSwitchFile remains authoritative.
  if (resolve(input.killSwitchFile) !== resolve(input.root, '.paused')) return normalized;
  return { ...normalized, killSwitchFile: resolve(runtimeRoot, '.paused') };
}

function kernelConsoleCapabilities(base: ConsoleCapabilities, hostIdentity: boolean): ConsoleCapabilities {
  if (!hostIdentity) return base;
  return {
    ...base,
    // Human accounts and passwords belong to the Host identity domain. Core
    // machine/client/executor credentials remain available through their own modules.
    modules: base.modules.filter((module) => module !== 'accounts'),
  };
}

async function settlesWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function kernelCloseDrainMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_KERNEL_CLOSE_DRAIN_MS) {
    throw new Error(`Kernel close drainMs must be a safe integer between 0 and ${MAX_KERNEL_CLOSE_DRAIN_MS}`);
  }
  return value;
}

export function createBailingHubKernel(input: CreateBailingHubKernelInputV1): BailingHubKernelV1 {
  const instanceKey = assertInstanceKey(input.instanceKey);
  const httpMountPath = normalizeHttpMountPath(input.httpMountPath);
  const cfg = kernelRuntimeConfig(input.config);
  if (!cfg.runtimeRoot && input.schedulerMode === 'managed') {
    // managed 既可用于单实例嵌入，也可用于多 Kernel；保持兼容但把责任写进契约。
    input.logger?.warn?.(`[Kernel ${instanceKey}] 未设置 runtimeRoot，将沿用 root；多实例宿主必须注入实例独立目录`);
  }
  const logger = input.logger ?? console;
  const schedulerMode = input.schedulerMode ?? 'managed';
  const edition = createOssEdition(cfg, { logger });
  const localAdminManagement = !input.identityProvider;
  const consoleCapabilities = kernelConsoleCapabilities(edition.capabilities, !localAdminManagement);
  const targetRegistry = new TargetRegistry();
  const composition = createRuntimeComposition({
    cfg,
    edition,
    targetRegistry,
    jobStream: input.jobStream,
    // 每个 Kernel 保留自己的 drain/统计；宿主队列只作为全局并发闸。
    queue: new Queue(cfg.concurrency, input.executionQueue),
    serialScope: instanceKey,
  });
  const demoDataset = composition.cfgStore ? new DemoDatasetService(composition.cfgStore, cfg.demoDataset) : null;
  const runtimeHelpers = createRuntimeContextHelpers({
    cfg,
    scopeResolver: edition.scopeResolver as ScopeResolver<Principal | null | undefined>,
    storeFactory: edition.storeFactory,
  });
  const resolveProjectPathForHost = async (configStore: typeof composition.cfgStore, name: string): Promise<string | null> => {
    const path = await runtimeHelpers.resolveProjectPathFor(configStore, name);
    if (!path || !input.projectPathPolicy) return path;
    return await input.projectPathPolicy({ name, path });
  };
  const hostRuntimeHelpers = { ...runtimeHelpers, resolveProjectPathFor: resolveProjectPathForHost };
  const isPaused = (): boolean => existsSync(cfg.killSwitchFile);
  const wecomAccessTokenCache = new WecomAccessTokenCache();
  const kernelChannelSendFor: typeof channelSendFor = (config, channelName, recipient, message) =>
    channelSendFor(config, channelName, recipient, message, wecomAccessTokenCache);
  const engine = createEngineRuntime({
    cfg,
    configStore: composition.cfgStore,
    stateStore: composition.store,
    kbService: composition.kbService,
    toolIndex: composition.toolIndex,
    queue: composition.queue,
    isPaused,
    resolveProjectPath: (name) => resolveProjectPathForHost(composition.cfgStore, name),
    now,
    sleep,
    jobStream: composition.jobStream,
    launchGuard: input.launchGuard
      ? async (spec) => await input.launchGuard!(kernelLaunchRequestV1(spec))
      : undefined,
    targetRegistry,
    serialScope: instanceKey,
    channelSendFor: kernelChannelSendFor,
  });

  const lifecycleDeps: RuntimeLifecycleDeps = {
    cfg,
    configStore: composition.cfgStore,
    stateStore: composition.store,
    kbService: composition.kbService,
    kbSync: composition.kbSync,
    toolIndex: composition.toolIndex,
    isPaused,
    refreshTargets: () => engine.refreshTargets(),
    kickInhubScheduler: () => engine.kickInhubScheduler(),
    drainInhubScheduler: (maxClaims) => engine.drainInhubScheduler(maxClaims),
    recoverInhubJobs: (scope, staleMs) => engine.recoverInhubJobs(scope, staleMs),
    now,
    sleep,
    targetRegistry,
    afterStoresInitialized: !localAdminManagement || input.bootstrapLocalAdmin === false
      ? undefined
      : async () => { await bootstrapInitialAdmin(cfg.bootstrapAdmin, { admins: composition.cfgStore?.admins ?? null }); },
  };

  const brandingProvider = input.brandingProvider ?? edition.brandingProvider;
  const metrics = createOperationalMetricsEndpointFor({
    cfg,
    store: composition.store,
    configStore: composition.cfgStore,
    queue: composition.queue,
    isPaused,
    auditFailures: edition.auditFailures,
    logger,
  });

  const runDeps: RunApiDeps = {
    cfg,
    isPaused,
    ...hostRuntimeHelpers,
    engineForContext: () => engine,
    targetRegistry,
  };
  const chatDeps: ChatApiDeps = {
    cfg,
    httpMountPath,
    isPaused,
    ...hostRuntimeHelpers,
    now,
    jobStream: composition.jobStream,
    engineForContext: () => engine,
    targetRegistry,
  };
  const sendDeps: SendApiDeps = {
    cfg,
    isPaused,
    ...hostRuntimeHelpers,
    now,
    channelSendFor: kernelChannelSendFor,
  };
  const wecomRuntimeState = new WecomRuntimeState();
  const executorRuntimeState = new ExecutorRuntimeState();
  const executorDeps: ExecutorApiDeps = {
    cfg,
    toolIndex: composition.toolIndex,
    isPaused,
    ...hostRuntimeHelpers,
    now,
    sleep,
    toolsForWorkItemFor: (deps, job) => toolsForWorkItemFor({ ...deps, targetRegistry }, job),
    engineForContext: () => engine,
    targetRegistry,
    runtimeState: executorRuntimeState,
  };
  const wecomDeps: WecomApiDeps = {
    cfg,
    httpMountPath,
    isPaused,
    ...hostRuntimeHelpers,
    now,
    engineForContext: () => engine,
    targetRegistry,
    runtimeState: wecomRuntimeState,
    accessTokenCache: wecomAccessTokenCache,
  };
  const outboundDeps = outboundRuntimeDepsFor({
    cfg,
    configStore: composition.cfgStore,
    stateStore: composition.store,
    now,
    sleep,
    channelSendFor: kernelChannelSendFor,
  });

  const privateDeps: PrivateHttpDeps = {
    cfg,
    configStore: composition.cfgStore,
    stateStore: composition.store,
    kbService: composition.kbService,
    toolIndex: composition.toolIndex,
    identityProvider: input.identityProvider,
    targetRegistry,
    handleAdminApi: (method, path, req, res, principal) => handleAdminApiFor({
      cfg,
      configStore: composition.cfgStore,
      brandingProvider,
      stateStore: composition.store,
      capabilities: consoleCapabilities,
      kbService: composition.kbService,
      kbSync: composition.kbSync,
      toolIndex: composition.toolIndex,
      isPaused,
      now,
      sleep,
      queueStats: () => composition.queue.stats(),
      channelSend: (channel, recipient, message) => kernelChannelSendFor(composition.cfgStore, channel, recipient, message),
      engineRuntime: engine,
      refreshTargets: () => targetRegistry.refresh(),
      targetRegistry,
      httpMountPath,
      localAdminManagement,
      demoDataset,
    }, method, path, req, res, principal),
    handleApprovalDecision: (req, res, approvalId, url) => handleApprovalDecisionFor({
      cfg,
      configStore: composition.cfgStore,
      stateStore: composition.store,
      now,
      sleep,
      secretForJob: (job: Job) => secretForJobWithDeps(outboundDeps, job),
      engineRuntime: engine,
    }, req, res, approvalId, url),
    handleExecutorClaim: (req, res, principal) => handleExecutorClaimFor(executorDeps, req, res, principal),
    handleExecutorHeartbeat: (req, res, principal) => handleExecutorHeartbeatFor(executorDeps, req, res, principal),
    handleExecutorResult: (req, res) => handleExecutorResultFor(executorDeps, req, res),
    handleKbSearchFor,
    handleKbIngestFor,
    handleKbIngestListFor,
    handleRun: (req, res, principal) => handleRunFor(runDeps, req, res, principal),
    handleSend: (req, res, principal) => handleSendFor(sendDeps, req, res, principal),
    handleWecomInbound: (req, res, accountId, url) => handleWecomInboundFor(wecomDeps, req, res, accountId, url),
  };

  const publicDeps = {
    cfg,
    mountPath: httpMountPath,
    configStore: composition.cfgStore,
    brandingProvider,
    queue: composition.queue,
    isPaused,
    metrics,
    readiness: () => checkReadinessFor(cfg, composition.cfgStore),
    operationalStatus: () => {
      const audit = edition.auditFailures.snapshot();
      return { audit_write_failures: audit.total, last_audit_failure_at: audit.lastFailureAt };
    },
    serveConsole: (urlPath: string, res: ServerResponse, head?: boolean) => serveConsoleFromRoot(cfg.root, urlPath, res, head, httpMountPath),
    handleChat: (req: IncomingMessage, res: ServerResponse, entryKey: string) => handleChatFor(chatDeps, req, res, entryKey),
    handleChatConfig: (req: IncomingMessage, res: ServerResponse, entryKey: string) => handleChatConfigFor(chatDeps, req, res, entryKey),
    handleChatEvents: (req: IncomingMessage, res: ServerResponse, entryKey: string, jobId: string, url: URL) => handleChatEventsFor(chatDeps, req, res, entryKey, jobId, url),
    handleChatThread: (req: IncomingMessage, res: ServerResponse, entryKey: string, url: URL) => handleChatThreadFor(chatDeps, req, res, entryKey, url),
    handleChatUpload: (req: IncomingMessage, res: ServerResponse, entryKey: string) => handleChatUploadFor(chatDeps, req, res, entryKey),
    handleChatRate: (req: IncomingMessage, res: ServerResponse, entryKey: string, jobId: string) => handleChatRateFor(chatDeps, req, res, entryKey, jobId),
    serveChatDemo: (res: ServerResponse, entryKey: string) => serveChatDemoFor(chatDeps, res, entryKey, httpMountPath),
  };

  let initialized = false;
  let initializePromise: Promise<void> | null = null;
  let schedulers: RuntimeSchedulers | null = null;
  let bootRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let managedMaintenance: ManagedRuntimeMaintenance | null = null;
  let closing = false;
  let closed = false;
  let activeRequests = 0;
  let activeDrain: (() => void) | null = null;
  let releaseTimezone: (() => void) | null = null;
  let closePromise: Promise<void> | null = null;

  async function initialize(): Promise<void> {
    if (closing || closed) throw new Error(`Kernel ${instanceKey} is closing`);
    if (initialized) return;
    if (!initializePromise) {
      initializePromise = (async () => {
        releaseTimezone = claimProcessTimezone(cfg);
        try {
          await initializeRuntimeLifecycleFor(lifecycleDeps);
          if (schedulerMode === 'managed') {
            managedMaintenance = createManagedRuntimeMaintenanceFor(lifecycleDeps, {
              state: input.managedMaintenanceState,
            });
          }
          initialized = true;
        } catch (error) {
          releaseTimezone?.();
          releaseTimezone = null;
          throw error;
        }
      })();
    }
    await initializePromise;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url?: URL): Promise<void> {
    if (closing || closed) {
      send(res, 503, { error: 'kernel closing' });
      return;
    }
    await initialize();
    if (closing || closed) {
      send(res, 503, { error: 'kernel closing' });
      return;
    }
    activeRequests++;
    try {
      const requestUrl = url ?? new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (await handlePublicHttpFor(publicDeps, req, res, requestUrl)) return;
      await handlePrivateHttpFor(privateDeps, req, res, requestUrl);
    } finally {
      activeRequests--;
      if (activeRequests === 0) {
        activeDrain?.();
        activeDrain = null;
      }
    }
  }

  async function tick(maxClaims = 1): Promise<number> {
    if (closing || closed) return 0;
    await initialize();
    if (closing || closed) return 0;
    if (managedMaintenance) return await managedMaintenance.tick(maxClaims);
    // 未发布的 Kernel API 早期行为兼容：standalone 的完整维护仍由原定时器驱动。
    await targetRegistry.refresh();
    return await engine.drainInhubScheduler(maxClaims);
  }

  async function close(drainMs = 30_000): Promise<void> {
    const boundedDrainMs = kernelCloseDrainMs(drainMs);
    if (closed) return;
    if (closePromise) return await closePromise;
    const deadline = Date.now() + boundedDrainMs;
    const remainingDrainMs = (): number => Math.max(0, deadline - Date.now());
    closing = true;
    closePromise = (async () => {
      // initialize 可能已被首个请求/tick 启动；必须等它完成或失败后再停维护、关连接池。
      if (initializePromise) {
        const initializedWithinBudget = await settlesWithin(initializePromise.catch(() => undefined), remainingDrainMs());
        if (!initializedWithinBudget) throw new Error(`Kernel ${instanceKey} initialization drain timed out`);
      }
      schedulers?.stop();
      schedulers = null;
      if (bootRecoveryTimer) clearTimeout(bootRecoveryTimer);
      bootRecoveryTimer = null;
      if (managedMaintenance) {
        const maintenanceDrained = await managedMaintenance.stop(remainingDrainMs());
        if (!maintenanceDrained) throw new Error(`Kernel ${instanceKey} managed maintenance drain timed out`);
        managedMaintenance = null;
      }
      if (activeRequests > 0) {
        const requestsDrained = await Promise.race([
          new Promise<boolean>((resolve) => { activeDrain = () => resolve(true); }),
          sleep(remainingDrainMs()).then(() => false),
        ]);
        if (!requestsDrained) throw new Error(`Kernel ${instanceKey} request drain timed out`);
      }
      const inhubDrained = await settlesWithin(engine.stopInhubRuntime(), remainingDrainMs());
      if (!inhubDrained) throw new Error(`Kernel ${instanceKey} inhub runtime drain timed out`);
      composition.queue.closeAdmission();
      const queueDrained = await composition.queue.drain(remainingDrainMs());
      if (!queueDrained) throw new Error(`Kernel ${instanceKey} execution queue drain timed out`);
      targetRegistry.bindStore(null);
      wecomRuntimeState.dispose();
      wecomAccessTokenCache.dispose();
      executorRuntimeState.dispose();
      const resourcesClosed = await settlesWithin(edition.close(), remainingDrainMs());
      if (!resourcesClosed) throw new Error(`Kernel ${instanceKey} resource drain timed out`);
      releaseTimezone?.();
      releaseTimezone = null;
      closed = true;
    })();
    try {
      await closePromise;
    } catch (error) {
      // Keep closing=true so no new work can enter, but allow a later close()
      // call to retry draining instead of spinning forever or closing live DBs.
      closePromise = null;
      throw error;
    }
  }

  function createStandaloneServer(options: { exit?: (code: number) => void } = {}): KernelStandaloneServerV1 {
    if (schedulerMode !== 'standalone') {
      throw new Error('createStandaloneServer requires schedulerMode=standalone');
    }
    return createBailingHttpServer({
      cfg,
      configStore: composition.cfgStore,
      queue: composition.queue,
      handlePublicHttp: async (req, res, url) => {
        await handle(req, res, url);
        return true;
      },
      handlePrivateHttp: async () => undefined,
      initializeRuntimeLifecycle: initialize,
      startRuntimeSchedulers: () => {
        schedulers ??= startRuntimeSchedulersFor(lifecycleDeps);
        return schedulers;
      },
      scheduleBootRecovery: () => {
        bootRecoveryTimer ??= scheduleBootRecoveryFor(lifecycleDeps);
        return bootRecoveryTimer;
      },
      closeRuntime: () => close(),
      logger,
      exit: options.exit,
    });
  }

  return {
    instanceKey,
    config: cfg,
    initialize,
    handle,
    tick,
    readiness: () => checkReadinessFor(cfg, composition.cfgStore),
    close,
    createStandaloneServer,
    isClosing: () => closing || closed,
  };
}

/** 测试与宿主可用的最小上下文构造器；不会触发默认 runtime 单例。 */
export function kernelSystemContextV1(instanceKey: string) {
  return createRuntimeContext({ requestId: `kernel:${instanceKey}`, source: 'system' });
}
