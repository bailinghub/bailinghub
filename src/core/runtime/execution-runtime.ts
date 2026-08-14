// 执行运行时：准备 AdapterContext（target_config / tools / builtin send）并给出 retry 决策。
// 不依赖 runtime 单例；engine 负责传入 cfg、store、工具装配函数与目标注册表能力。
import type { AppConfig } from '../config/config';
import { injectLlmRuntimeCredentials, type CredentialStoreLike } from './credential-resolver';
import { routeRetryConfig } from '../config/route-config';
import { normalizeTargetConfig } from '../config/target-config';
import type { AdapterContext, AdapterResult, BuiltinToolDef } from '../targets/adapter';
import type { Job, Route, SessionTarget } from '../contracts/types';
import type {
  ToolExecutionJournalRecord,
  ToolExecutionUncertainty,
  ToolRuntime,
} from '../contracts/tools';
import type { JobStreamEventInput } from './job-stream';

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
    audit?: ExecutionAudit,
  ) => Promise<{ ok: boolean; text: string; uncertainty?: ToolExecutionUncertainty }>;
  audit?: ExecutionAudit;
  stream?: (event: JobStreamEventInput) => void;
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

function supportsPresentationRenderer(metadata: Record<string, unknown> | undefined, renderer: string): boolean {
  const capabilities = metadata?.['presentation_capabilities'];
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false;
  const renderers = (capabilities as Record<string, unknown>)['renderers'];
  return Array.isArray(renderers) && renderers.includes(renderer);
}

const BAILING_CHART_PROMPT = [
  '【可选展示能力】当前聊天客户端支持 bailing-chart 图表。',
  '仅当回答包含真实、已经获得的数值数据，并且图表明显比纯文本更有助于理解时，才主动在简短结论后输出一个 bailing-chart fenced code block。',
  '趋势数据使用 line，类别比较使用 bar，少量构成占比使用 pie。无适合数据时保持文本或 Markdown 表格。',
  '不得为了生成图表而猜测、补造、插值或改写任何数值；图表不能替代审批、授权、审计或业务系统校验。',
  '代码块内容必须是严格 JSON，且只能包含 kind、title、seriesName、unit、data；data 每项只能包含 label 和 value。',
  '示例：```bailing-chart\n{"kind":"line","title":"近七日营业额","seriesName":"营业额","unit":"元","data":[{"label":"周一","value":12800}]}\n```',
].join('\n');

export async function prepareAdapterContext(input: PrepareAdapterContextInput): Promise<AdapterContext> {
  const target = input.job.target ?? '';
  let targetConfig = normalizeTargetConfig(target, input.route?.target_config ?? input.job.dispatch?.target_config ?? {});
  if (target === 'llm') {
    targetConfig = await injectLlmRuntimeCredentials(targetConfig, input.cfg, input.credentialStore);
    if (supportsPresentationRenderer(input.job.metadata, 'bailing-chart')) {
      targetConfig = appendSystemPrompt(targetConfig, BAILING_CHART_PROMPT);
    }
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
      '【可信业务身份缺失】本次会话未收到业务系统后端签发的可信身份票据，因此所有要求业务主体的工具均未向 Agent 暴露，不能查询或办理相关业务，也不得猜测或编造业务数据。不要声称当前对话框存在登录入口或能够自行完成登录，不要向用户索要账号、密码、Token、用户 ID 等凭据或身份标识。若助手嵌入真实业务系统，应引导用户返回该业务系统完成登录，再由业务系统后端签发身份票据并重新打开或刷新助手；独立匿名预览不能自行解锁这些能力。',
    );
  } else {
    tools = assembled;
  }

  const sendChannels = await input.resolveSendChannels((input.route?.tools ?? input.job.dispatch?.tools) as Record<string, unknown> | undefined).catch(() => [] as string[]);
  let sendUncertainty: ToolExecutionUncertainty | null = null;
  const send = sendChannels.length
    ? {
        def: input.makeSendToolDef(sendChannels),
        async run(args: Record<string, unknown>) {
          if (sendUncertainty) {
            return { ok: false, text: sendUncertainty.message, uncertainty: sendUncertainty };
          }
          const result = await input.runSendMessage(
            input.job,
            sendChannels,
            args,
            (event, detail) => input.audit?.(event, detail),
          );
          if (result.uncertainty) sendUncertainty = result.uncertainty;
          return result;
        },
        executionUncertainty() {
          return sendUncertainty;
        },
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
    stream: input.stream,
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

/** 工具执行进入不确定边界后，适配器即使产出了普通回复，也必须以不可重试的对账终态收口。 */
export function applyToolExecutionBoundary(
  result: AdapterResult,
  tools: ToolRuntime | undefined,
  send?: AdapterContext['send'],
): AdapterResult {
  const uncertainty = tools?.executionUncertainty() ?? send?.executionUncertainty() ?? null;
  if (!uncertainty) return result;
  return applyToolExecutionUncertainty(result, uncertainty);
}

/** 把恢复时发现的未决持久化记录还原为同一套对账边界，不依赖模型再次选择该工具。 */
export function persistedToolExecutionUncertainty(entry: ToolExecutionJournalRecord): ToolExecutionUncertainty {
  const state = entry.state === 'completed' ? 'response_recorded' : entry.state;
  const reason = entry.error ?? `恢复时检测到执行日志状态 ${state}`;
  return {
    state,
    tool: entry.tool,
    scope: entry.scope,
    idempotency_key: entry.idempotencyKey,
    reason,
    message: `工具 ${entry.tool} 已存在未完成的执行记录（${state}）。系统不能确认是否已经产生业务后果，因此禁止自动重放；请使用幂等键 ${entry.idempotencyKey} 人工对账。`,
  };
}

/** 将任意适配器结果收敛为不可自动重试的人工对账终态。 */
export function applyToolExecutionUncertainty(
  result: AdapterResult,
  uncertainty: ToolExecutionUncertainty,
): AdapterResult {
  return {
    ...result,
    ok: false,
    transient: false,
    output: {
      ...result.output,
      governance_state: 'reconciliation_required',
      auto_retry_allowed: false,
      tool_execution: uncertainty,
    },
    error: 'tool_execution_reconciliation_required',
  };
}
