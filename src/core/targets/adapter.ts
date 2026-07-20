import type { AppConfig } from '../config/config';
import type { Route, SessionTarget } from '../contracts/types';
import type { ToolRuntime } from '../contracts/tools';
import type { FileRef } from '../platform/content';
import type { JobStreamEventInput } from '../runtime/job-stream';

export const SEND_TOOL_NAME = 'send_message';
/** 单个任务内主动发送的次数上限（防大脑失控群发/刷屏）；与业务工具 max_calls 各自独立计数。 */
export const SEND_MAX_CALLS = 20;

/** OpenAI function-calling 形态的工具定义（与 llm 内置 see_image 同构）。 */
export interface BuiltinToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 内置「主动发消息」能力：路由配了 tools.builtin.send_message.channels 时由中枢预绑（含 job + 渠道白名单）注入。
 * 适配器只管把 def 暴露给大脑、把大脑的调用转给 run——不碰 cfgStore/收件人映射（中枢不持有谁是谁）。 */
export interface SendCapability {
  def: BuiltinToolDef;
  run(args: Record<string, unknown>): Promise<{ ok: boolean; text: string }>;
}

/** 一次调度的上下文，交给具体 target 适配器执行 */
export interface AdapterContext {
  requestId: string;
  input: string;
  /** 本轮用户的原始问题（不含 KB/会话背景/权限前置等装配块）；工具检索按它选相关工具，比用装配后的 input 更准。缺省回落 input。 */
  userQuery?: string;
  /** 用户原始输入里的图片 URL（仅用户发的，不含知识库注入截图）；多模态适配器据此把图作为 image_url 部件喂给模型 */
  userImages?: string[];
  /** 用户原始输入里的音频 URL（仅用户发的）；音频适配器据此转写或直送具备语音理解能力的模型/执行器 */
  userAudio?: string[];
  /** 用户原始输入里的文件 URL（仅用户发的）；文件输入策略据此抽取、摘要或直送 */
  userFiles?: FileRef[];
  metadata: Record<string, unknown>;
  source: string;
  route: Route | null;
  targetConfig: Record<string, unknown>;
  session: SessionTarget;
  profileName: string;
  projectPath: string | null;
  cfg: AppConfig;
  /** 工具插座：路由挂了 tools 时由中枢装配注入（清单+受治理的调用句柄）。详见 docs/TOOLS_DESIGN.md */
  tools?: ToolRuntime;
  /** 内置「主动发消息」动作：路由配了 tools.builtin.send_message.channels 时注入；大脑当场命名收件人发消息（中枢只校验渠道白名单）。 */
  send?: SendCapability;
  /** 统一工具面（执行器侧）：派发方渲染好的工具使用说明（可信指令，含调用入口与 tool_token），提示词驱动的大脑直接拼进提示 */
  toolsPrompt?: string;
  /** 审计钩子：适配器内部的可观测事件（如感知层 see_image 调用）写进任务总账（bz_audit）。由中枢派发时注入，失败不阻塞。 */
  audit?: (event: string, detail: Record<string, unknown>) => void;
  /** 临时输出事件：只用于实时传输，不进入任务结果、会话总账或审计库。回调失败不得中断模型执行。 */
  stream?: (event: JobStreamEventInput) => void;
}

/** 各 target 统一的返回。output 是写进 bz_jobs.result 的结构化结果。 */
export interface AdapterResult {
  ok: boolean;
  output: Record<string, unknown>; // 如 { text } 或 { report }
  usage?: { duration_ms?: number; num_turns?: number; cost_usd?: number; tokens?: number };
  sessionId?: string;
  error?: string;
  transient?: boolean; // 瞬时失败（网络/超时/5xx/429）：路由配了 retry 时可重试；配置类错误永远不重试
}

export interface TargetAdapter {
  run(ctx: AdapterContext): Promise<AdapterResult>;
}
