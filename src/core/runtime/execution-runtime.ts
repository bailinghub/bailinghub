// 执行运行时：准备 AdapterContext（target_config / tools / builtin send）并给出 retry 决策。
// 不依赖 runtime 单例；engine 负责传入 cfg、store、工具装配函数与目标注册表能力。
import type { AppConfig } from '../config/config';
import { injectLlmRuntimeCredentials, type CredentialStoreLike } from './credential-resolver';
import { routeRetryConfig } from '../config/route-config';
import { normalizeTargetConfig } from '../config/target-config';
import type { AdapterContext, AdapterResult, BuiltinToolDef } from '../targets/adapter';
import type { Job, Route, SessionTarget } from '../contracts/types';
import type { ToolRuntime } from '../contracts/tools';

export type ExecutionAudit = (event: string, detail: Record<string, unknown>) => Promise<void> | void;

export interface PrepareAdapterContextInput {
  job: Job;
  route: Route | null;
  fullInput: string;
  session: SessionTarget;
  projectPath: string | null;
  cfg: AppConfig;
  credentialStore?: CredentialStoreLike | null;
  targetTimeoutMs: (target: string, targetConfig: Record<string, unknown>) => number;
  assembleToolRuntime: (job: Job, route: Route | null) => Promise<ToolRuntime | 'subject_locked' | undefined>;
  resolveSendChannels: (toolsConfig: Record<string, unknown> | undefined) => Promise<string[]>;
  makeSendToolDef: (channels: string[]) => BuiltinToolDef;
  runSendMessage: (
    job: Job,
    allowedChannels: string[],
    args: Record<string, unknown>,
    audit?: (event: string, detail: Record<string, unknown>) => void,
  ) => Promise<{ ok: boolean; text: string }>;
  audit?: ExecutionAudit;
}

export interface RetryDecision {
  attempt: number;
  max: number;
  backoffMs: number;
  error: string;
}

function appendSystemPrompt(targetConfig: Record<string, unknown>, prompt: string): Record<string, unknown> {
  return {
    ...targetConfig,
    system_prompt: [String(targetConfig['system_prompt'] ?? ''), prompt].filter(Boolean).join('\n'),
  };
}

export async function prepareAdapterContext(input: PrepareAdapterContextInput): Promise<AdapterContext> {
  const target = input.job.target ?? '';
  let targetConfig = normalizeTargetConfig(target, input.route?.target_config ?? input.job.dispatch?.target_config ?? {});
  if (target === 'llm') {
    targetConfig = await injectLlmRuntimeCredentials(targetConfig, input.cfg, input.credentialStore);
  }
  targetConfig = { ...targetConfig, _timeout_ms: input.targetTimeoutMs(target, targetConfig) };

  const assembled = await input.assembleToolRuntime(input.job, input.route).catch(async (e) => {
    await input.audit?.('tools_unavailable', { error: String(e).slice(0, 200) });
    return undefined;
  });
  let tools: ToolRuntime | undefined;
  if (assembled === 'subject_locked') {
    await input.audit?.('tools_locked', { reason: 'no_subject' });
    targetConfig = appendSystemPrompt(
      targetConfig,
      '【系统提示】本次会话的访客未携带登录身份，业务数据的查询/办理能力处于锁定状态。如用户需要查询或办理业务，请告知其先登录系统再使用对话助手（登录后自动携带身份）；不要虚构业务数据。',
    );
  } else {
    tools = assembled;
  }

  const sendChannels = await input.resolveSendChannels((input.route?.tools ?? input.job.dispatch?.tools) as Record<string, unknown> | undefined).catch(() => [] as string[]);
  const send = sendChannels.length
    ? {
        def: input.makeSendToolDef(sendChannels),
        run: (args: Record<string, unknown>) => input.runSendMessage(input.job, sendChannels, args,
          (event, detail) => { void input.audit?.(event, detail); }),
      }
    : undefined;

  return {
    requestId: input.job.request_id,
    input: input.fullInput,
    userQuery: input.job.input_preview || input.fullInput,
    userImages: input.job.dispatch?.user_images ?? [],
    userAudio: input.job.dispatch?.user_audio ?? [],
    userFiles: input.job.dispatch?.user_files ?? [],
    metadata: input.job.metadata,
    source: input.job.source,
    route: input.route,
    targetConfig,
    session: input.session,
    profileName: input.job.profile,
    projectPath: input.projectPath,
    cfg: input.cfg,
    tools,
    send,
    audit: (event, detail) => { void input.audit?.(event, detail); },
  };
}

export function retryDecision(job: Job, route: Route | null, result: AdapterResult): RetryDecision | null {
  if (result.ok || !result.transient) return null;
  const retry = routeRetryConfig(route?.retry ?? job.dispatch?.retry);
  const attempt = job.attempts ?? 0;
  if (attempt >= retry.max) return null;
  return {
    attempt: attempt + 1,
    max: retry.max,
    backoffMs: retry.backoff_ms,
    error: (result.error ?? '').slice(0, 200),
  };
}
