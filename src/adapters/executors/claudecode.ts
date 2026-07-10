import { resolveProfile } from './profiles';
import { runClaude } from './runner';
import { extractReport } from './report';
import type { AdapterContext, AdapterResult, TargetAdapter } from '../../core/targets/adapter';

/**
 * claude-code：派给本机 Claude Code 执行（参考执行器适配器，随本仓执行器进程跑在有 claude 二进制的机器上）。
 * 能力边界由能力档（brain/profiles.json）的工具白名单约束；场景措辞住在能力档的系统提示词里。
 * structuredOutput 档：尝试从输出提取 JSON 作为 report（schema 由该档提示词约定）；其余档输出纯文本。
 */
export const claudeCodeAdapter: TargetAdapter = {
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    if (!ctx.projectPath) return { ok: false, output: {}, error: 'claude-code 需要 project' };
    let profile;
    try {
      profile = resolveProfile(ctx.cfg.brainDir, ctx.profileName);
    } catch (e) {
      return { ok: false, output: {}, error: String(e) };
    }
    const outcome = await runClaude(
      { request_id: ctx.requestId, input: ctx.input, source: ctx.source, metadata: ctx.metadata },
      profile, ctx.projectPath, ctx.cfg.claudeBin, ctx.session, ctx.toolsPrompt,
    );
    if (outcome.isError) {
      return { ok: false, output: { raw: outcome.rawResult }, usage: outcome.usage, sessionId: outcome.sessionId, error: outcome.errorText };
    }
    if (!profile.structuredOutput) {
      return { ok: true, output: { text: outcome.rawResult }, usage: outcome.usage, sessionId: outcome.sessionId };
    }
    const { report, parseError } = extractReport(outcome.rawResult);
    return {
      ok: true,
      output: report ? { report } : { raw: outcome.rawResult },
      usage: outcome.usage,
      sessionId: outcome.sessionId,
      error: parseError,
    };
  },
};
