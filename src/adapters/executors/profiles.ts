import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** brain/profiles.json 中单个能力档的形态 */
export interface ProfileSpec {
  description: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
  appendSystemPromptFile?: string;
  structuredOutput?: boolean; // true=该档的提示词约定了 JSON 输出，执行后尝试提取 report；默认 false 纯文本
}

/** 解析后供 runner 使用（已读入系统提示正文） */
export interface ResolvedProfile {
  name: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
  appendSystemPrompt: string;
  structuredOutput: boolean;
}

/**
 * 在不带 .local 的路径里插入 `.local`：
 *   profiles.json            → profiles.local.json
 *   agents/code-review.md    → agents/code-review.local.md
 * 用于「叠加层」：仓库跟踪默认文件，部署方的定制写进同名 .local 兄弟文件（已 gitignore），
 * 升级时 git pull 只动默认文件、绝不碰用户的 .local，因此永不冲突。
 */
function localVariant(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  return dot <= 0 ? `${relPath}.local` : `${relPath.slice(0, dot)}.local${relPath.slice(dot)}`;
}

/** 读默认文件；若存在同名 .local 兄弟文件则改读它（部署方定制覆盖默认，不改跟踪文件）。 */
function readWithLocalOverride(brainDir: string, relPath: string): string {
  const local = join(brainDir, localVariant(relPath));
  return readFileSync(existsSync(local) ? local : join(brainDir, relPath), 'utf8');
}

/**
 * 加载能力档：brain/profiles.json（仓库默认）叠加 brain/profiles.local.json（部署方定制，可选、已 gitignore）。
 * 合并按能力档名（顶层 key）整档覆盖：.local 里同名档替换默认档、新名档追加。这样升级默认档不会跟用户定制撞 merge。
 */
function loadProfiles(brainDir: string): Record<string, ProfileSpec> {
  const base = JSON.parse(readFileSync(join(brainDir, 'profiles.json'), 'utf8')) as Record<string, ProfileSpec>;
  const localPath = join(brainDir, 'profiles.local.json');
  if (!existsSync(localPath)) return base;
  const local = JSON.parse(readFileSync(localPath, 'utf8')) as Record<string, ProfileSpec>;
  return { ...base, ...local };
}

/** 本机可用能力档名（base + .local 叠加后的全部 key）。执行器上报能力用——让中枢知道这台机器能跑哪些 profile。 */
export function listProfileNames(brainDir: string): string[] {
  try { return Object.keys(loadProfiles(brainDir)); } catch { return []; }
}

export function resolveProfile(brainDir: string, name: string): ResolvedProfile {
  const all = loadProfiles(brainDir);
  const spec = all[name];
  if (!spec) throw new Error(`未知 profile: ${name}`);

  let appendSystemPrompt = '';
  if (spec.appendSystemPromptFile) {
    appendSystemPrompt = readWithLocalOverride(brainDir, spec.appendSystemPromptFile);
  }

  return {
    name,
    model: spec.model,
    maxTurns: spec.maxTurns,
    timeoutMs: spec.timeoutMs,
    permissionMode: spec.permissionMode,
    allowedTools: spec.allowedTools ?? [],
    disallowedTools: spec.disallowedTools ?? [],
    appendSystemPrompt,
    structuredOutput: spec.structuredOutput === true,
  };
}
