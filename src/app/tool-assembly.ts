import { TOOL_INLINE_MAX, type ToolRuntime, buildToolRuntime, composeToolRuntimes } from '../core/contracts/tools';
import type { Job, Route } from '../core/contracts/types';
import { approvedNoteForJobFor, approvalDepsForStores } from './tool-approvals';
import { conversationAddrOf, embedConfigOf, maxCallsOf, resolveAllowedToolsFor, retrievalOptsOf, type AllowedToolContext } from './tool-context';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ToolIndexService } from '../services/tools-index';
import type { AppConfig } from '../core/config/config';
import { defaultTargetRegistry, type TargetRegistry } from '../core/targets/registry';

/**
 * 工具插座装配：已过双闸的清单 → 受治理的工具运行时。
 * 装配失败抛错由调用方审计 tools_unavailable 并降级纯对话，不阻塞任务。
 */
export async function assembleToolRuntimeFor(
  config: ConfigStoreContract | null,
  state: RuntimeStateStore,
  index: ToolIndexService | null,
  job: Job,
  route: Route | null,
  appConfig: AppConfig,
  nowFn: () => string,
  sleepFn: (ms: number) => Promise<void>,
  targetRegistry: TargetRegistry = defaultTargetRegistry,
): Promise<ToolRuntime | 'subject_locked' | undefined> {
  const r = await resolveAllowedToolsFor(config, job, route);
  if (!r) return undefined;
  return assembleResolvedToolRuntimeFor(config, state, index, job, r, appConfig, nowFn, sleepFn, targetRegistry);
}

/**
 * 已解析工具面 → 受治理运行时。Agent 直调会先按独立 direct policy 裁剪并对
 * 写工具提级审批，再从这个入口组装；避免调用时重新组装出一份不同的清单。
 */
export async function assembleResolvedToolRuntimeFor(
  config: ConfigStoreContract | null,
  state: RuntimeStateStore,
  index: ToolIndexService | null,
  job: Job,
  r: AllowedToolContext,
  appConfig: AppConfig,
  nowFn: () => string,
  sleepFn: (ms: number) => Promise<void>,
  targetRegistry: TargetRegistry = defaultTargetRegistry,
): Promise<ToolRuntime | 'subject_locked' | undefined> {
  if (!r.allowed.length) return 'subject_locked';
  const maxCalls = maxCallsOf(r.toolsCfg);
  const retrievalMode = r.allowed.length > TOOL_INLINE_MAX;
  const approvedNote = await approvedNoteForJobFor(config, job.job_id);
  const runtimes = r.sources.filter((source) => source.allowed.length).map(({ provider, allowed, sourceCfg, onBehalfOf }) => {
    let retrieveNames: ((query: string) => Promise<string[] | null>) | undefined;
    const ec = embedConfigOf(provider);
    const ropts = retrievalOptsOf(sourceCfg);
    if (index && ec && ropts.enabled && retrievalMode) {
      const ti = index;
      const allowedSet = new Set(allowed.map((t) => t.name));
      retrieveNames = async (query: string) => {
        const hits = await ti.retrieve(provider.name, allowedSet, query, ec, {
          minScore: ropts.minScore,
          maxTools: ropts.maxTools,
          observe: async (observation) => {
            await state.appendAudit({
              ts: nowFn(),
              job_id: job.job_id,
              request_id: job.request_id,
              event: 'tools_retrieval_diagnostics',
              detail: { ...observation },
            });
          },
        }).catch(() => null);
        return hits === null ? null : hits.map((h) => h.name);
      };
    }
    return buildToolRuntime({
      provider,
      allowedTools: allowed,
      maxCalls,
      onBehalfOf,
      conversation: conversationAddrOf(job),
      jobId: job.job_id,
      clientAppId: job.client_app_id ?? '',
      truncateBytes: 8192,
      approvals: approvalDepsForStores(config, state, job, provider, r.toolsCfg, sourceCfg, appConfig, nowFn, sleepFn, targetRegistry),
      retrieveNames,
      retrievalMode,
      idempotency: config ? {
        get: (tool, hash) => config.toolCalls.get(job.job_id, tool, hash),
        reserve: (tool, scope, hash, idempotencyKey) => config.toolCalls.reserve(job.job_id, tool, scope, hash, idempotencyKey),
        recordResponse: (tool, hash, res) => config.toolCalls.recordResponse(job.job_id, tool, hash, res),
        complete: (tool, hash) => config.toolCalls.complete(job.job_id, tool, hash),
        markUncertain: (tool, hash, error) => config.toolCalls.markUncertain(job.job_id, tool, hash, error),
        markEvidenceDegraded: (tool, hash, error) => config.toolCalls.markEvidenceDegraded(job.job_id, tool, hash, error),
      } : undefined,
      rateLimit: config ? (bucket, limit, windowSec) => config.rateLimits.consume(bucket, limit, windowSec) : undefined,
      audit: async (event, detail) => {
        await state.appendAudit({ ts: nowFn(), job_id: job.job_id, request_id: job.request_id, event, detail });
      },
    });
  });
  return composeToolRuntimes(runtimes, maxCalls, approvedNote);
}
