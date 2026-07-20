export interface LlmVisionConfig {
  credential?: string;
  model?: string;
  mode?: 'tool' | 'prepass' | 'inline' | 'off';
  max_calls?: number;
  [key: string]: unknown;
}

export interface LlmAudioConfig {
  credential?: string;
  model?: string;
  mode?: 'transcribe' | 'inline' | 'off';
  max_bytes?: number;
  max_seconds?: number;
  [key: string]: unknown;
}

export interface LlmFileConfig {
  credential?: string;
  model?: string;
  mode?: 'extract' | 'summarize' | 'inline' | 'off';
  max_bytes?: number;
  max_chars?: number;
  [key: string]: unknown;
}

export interface LlmInputConfig {
  image?: LlmVisionConfig;
  audio?: LlmAudioConfig;
  file?: LlmFileConfig;
  video?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LlmTargetConfig {
  credential: string;
  model?: string;
  /** 网页聊天存在实时事件通道时是否请求模型流式输出；默认 true。 */
  streaming?: boolean;
  system_prompt?: string;
  temperature?: number;
  timeout_ms?: number;
  input?: LlmInputConfig;
  [key: string]: unknown;
}

export type TargetConfig = Record<string, unknown>;

const IMAGE_MODES = ['tool', 'prepass', 'inline', 'off'] as const;
const AUDIO_MODES = ['transcribe', 'inline', 'off'] as const;
const FILE_MODES = ['extract', 'summarize', 'inline', 'off'] as const;

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function cleanString(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

function intInRange(v: unknown, path: string, min: number, max: number): string | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return `${path} 必须是 ${min}..${max} 的整数`;
  return null;
}

function numInRange(v: unknown, path: string, min: number, max: number): string | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return `${path} 必须是 ${min}..${max} 的数字`;
  return null;
}

function normalizeKnownString(r: Record<string, unknown>, key: string): void {
  if (r[key] === undefined) return;
  const v = cleanString(r[key]);
  if (v) r[key] = v;
  else delete r[key];
}

function normalizeKnownNumber(r: Record<string, unknown>, key: string): void {
  if (r[key] === undefined) return;
  const n = Number(r[key]);
  if (Number.isFinite(n)) r[key] = n;
  else delete r[key];
}

export function targetConfig(v: unknown): TargetConfig {
  return record(v) ?? {};
}

export function validateTargetConfig(target: string, v: unknown): string | null {
  const tc = v === undefined ? {} : record(v);
  if (!tc) return 'target_config 必须是对象';
  const timeoutErr = intInRange(tc.timeout_ms, 'target_config.timeout_ms', 1000, 3_600_000);
  if (timeoutErr) return timeoutErr;
  if (target !== 'llm') return null;

  if (!cleanString(tc.credential)) return 'target=llm 时 target_config.credential 必填';
  const tempErr = numInRange(tc.temperature, 'target_config.temperature', 0, 2);
  if (tempErr) return tempErr;
  if (tc.streaming !== undefined && typeof tc.streaming !== 'boolean') return 'target_config.streaming 必须是 boolean';

  const inputProvided = tc.input !== undefined;
  const input = record(tc.input) ?? {};
  if (inputProvided && !record(tc.input)) return 'target_config.input 必须是对象';
  if (Object.keys(input).length) {
    const ic = input;
    const image = ic.image;
    if (image !== undefined) {
      const vc = record(image);
      if (!vc) return 'target_config.input.image 必须是对象';
      const mode = cleanString(vc.mode);
      if (vc.mode !== undefined && (!mode || !IMAGE_MODES.includes(mode as (typeof IMAGE_MODES)[number]))) {
        return `target_config.input.image.mode 仅支持 ${IMAGE_MODES.join(' / ')}`;
      }
      const maxCallsErr = intInRange(vc.max_calls, 'target_config.input.image.max_calls', 1, 30);
      if (maxCallsErr) return maxCallsErr;
    }
    const audio = ic.audio;
    if (audio !== undefined) {
      const ac = record(audio);
      if (!ac) return 'target_config.input.audio 必须是对象';
      const mode = cleanString(ac.mode);
      if (ac.mode !== undefined && (!mode || !AUDIO_MODES.includes(mode as (typeof AUDIO_MODES)[number]))) {
        return `target_config.input.audio.mode 仅支持 ${AUDIO_MODES.join(' / ')}`;
      }
      const maxBytesErr = intInRange(ac.max_bytes, 'target_config.input.audio.max_bytes', 1024, 50 * 1024 * 1024);
      if (maxBytesErr) return maxBytesErr;
      const maxSecondsErr = intInRange(ac.max_seconds, 'target_config.input.audio.max_seconds', 1, 600);
      if (maxSecondsErr) return maxSecondsErr;
    }
    const file = ic.file;
    if (file !== undefined) {
      const fc = record(file);
      if (!fc) return 'target_config.input.file 必须是对象';
      const mode = cleanString(fc.mode);
      if (fc.mode !== undefined && (!mode || !FILE_MODES.includes(mode as (typeof FILE_MODES)[number]))) {
        return `target_config.input.file.mode 仅支持 ${FILE_MODES.join(' / ')}`;
      }
      const maxBytesErr = intInRange(fc.max_bytes, 'target_config.input.file.max_bytes', 1024, 100 * 1024 * 1024);
      if (maxBytesErr) return maxBytesErr;
      const maxCharsErr = intInRange(fc.max_chars, 'target_config.input.file.max_chars', 1000, 200000);
      if (maxCharsErr) return maxCharsErr;
    }
  }
  return null;
}

function normalizeInputPart(
  input: Record<string, unknown>,
  key: 'image' | 'audio' | 'file',
  modes: readonly string[],
  numberKeys: string[],
): void {
  const raw = record(input[key]);
  if (!raw) {
    if (input[key] !== undefined) delete input[key];
    return;
  }
  const next = { ...raw };
  normalizeKnownString(next, 'credential');
  normalizeKnownString(next, 'model');
  if (next.mode !== undefined) {
    const mode = cleanString(next.mode);
    if (mode && modes.includes(mode)) next.mode = mode;
    else delete next.mode;
  }
  for (const numberKey of numberKeys) normalizeKnownNumber(next, numberKey);
  if (Object.keys(next).length) input[key] = next;
  else delete input[key];
}

export function normalizeTargetConfig(target: string, v: unknown): TargetConfig {
  const tc = { ...targetConfig(v) };
  normalizeKnownNumber(tc, 'timeout_ms');
  if (target !== 'llm') return tc;

  // llm 的多模态入口统一收敛在 input.{image,audio,file}。
  // 根级 vision/audio 不属于当前契约，保存或运行期归一化时直接剔除，避免配置形态分叉。
  delete tc.vision;
  delete tc.audio;

  normalizeKnownString(tc, 'credential');
  normalizeKnownString(tc, 'model');
  normalizeKnownString(tc, 'system_prompt');
  normalizeKnownNumber(tc, 'temperature');
  if (tc.streaming !== undefined && typeof tc.streaming !== 'boolean') delete tc.streaming;

  const input = { ...(record(tc.input) ?? {}) };

  normalizeInputPart(input, 'image', IMAGE_MODES, ['max_calls']);
  normalizeInputPart(input, 'audio', AUDIO_MODES, ['max_bytes', 'max_seconds']);
  normalizeInputPart(input, 'file', FILE_MODES, ['max_bytes', 'max_chars']);
  if (Object.keys(input).length) tc.input = input;
  else delete tc.input;
  return tc;
}

export function llmTargetConfig(v: unknown): LlmTargetConfig | null {
  const tc = normalizeTargetConfig('llm', v);
  const credential = cleanString(tc.credential);
  return credential ? { ...tc, credential } as LlmTargetConfig : null;
}
