import { TOOL_INLINE_MAX, type ToolRuntime, buildToolRuntime, composeToolRuntimes } from '../core/contracts/tools';
import type { Job, Route } from '../core/contracts/types';
import { approvedNoteForJobFor, approvalDepsForStores } from './tool-approvals';
import { conversationAddrOf, embedConfigOf, maxCallsOf, resolveAllowedToolsFor, retrievalOptsOf } from './tool-context';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ToolIndexService } from '../services/tools-index';
import type { AppConfig } from '../core/config/config';

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
): Promise<ToolRuntime | 'subject_locked' | undefined> {
  const r = await resolveAllowedToolsFor(config, job, route);
  if (!r) return undefined;
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
        const hits = await ti.retrieve(provider.name, allowedSet, query, ec, { minScore: ropts.minScore, maxTools: ropts.maxTools }).catch(() => null);
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
      approvals: approvalDepsForStores(config, state, job, provider, r.toolsCfg, sourceCfg, appConfig, nowFn, sleepFn),
      retrieveNames,
      retrievalMode,
      idempotency: config ? {
        get: (tool, hash) => config.toolCalls.get(job.job_id, tool, hash),
        put: (tool, hash, res) => config.toolCalls.put(job.job_id, tool, hash, res),
      } : undefined,
      rateLimit: config ? (bucket, limit, windowSec) => config.rateLimits.consume(bucket, limit, windowSec) : undefined,
      audit: async (event, detail) => {
        await state.appendAudit({ ts: nowFn(), job_id: job.job_id, request_id: job.request_id, event, detail });
      },
    });
  });
  return composeToolRuntimes(runtimes, maxCalls, approvedNote);
}
