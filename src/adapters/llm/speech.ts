import type { ResolvedCredential } from './perception';

export interface AudioConfig {
  /** 语音模型凭证名；留空复用 brain 凭证 */
  credential?: string;
  /** ASR 模型；留空用凭证默认模型 */
  model?: string;
  /** ASR 协议；transcriptions=传统转写端点，chat_input_audio=chat/completions 音频输入 */
  protocol?: AudioProtocol;
  /** transcribe=中枢先转文字；inline=音频直送具备语音理解能力的模型/执行器；off=忽略音频 */
  mode?: 'transcribe' | 'inline' | 'off';
  /** 单音频最大字节数，默认 AUDIO_MAX_BYTES_DEFAULT */
  max_bytes?: number;
  /** 单音频最大秒数（当前用于配置/审计表达，上传端不信任浏览器传值） */
  max_seconds?: number;
  /** 派发时由中枢注入的已解析凭证。 */
  _db_credential?: ResolvedCredential;
}

export type AudioProtocol = 'transcriptions' | 'chat_input_audio';

export const AUDIO_MODE_DEFAULT: 'transcribe' = 'transcribe';
export const AUDIO_PROTOCOL_DEFAULT: AudioProtocol = 'transcriptions';
export const AUDIO_MAX_BYTES_DEFAULT = 12 * 1024 * 1024;
export const AUDIO_TIMEOUT_MS = 60000;

export interface SpeechResult {
  ok: boolean;
  text: string;
}

function audioFilename(url: string, index: number): string {
  const path = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
  const name = path.split('/').pop() || '';
  return /\.[a-z0-9]{2,5}$/i.test(name) ? name : `audio-${index}.webm`;
}

export function resolveAudio(
  llmCredentials: Record<string, ResolvedCredential>,
  acfg: AudioConfig | undefined,
  brainCred: ResolvedCredential | undefined,
  brainCredName: string,
): { cred: ResolvedCredential; model: string; protocol: AudioProtocol } | null {
  if (!acfg) return null;
  const credName = String(acfg.credential ?? brainCredName ?? '');
  const cred =
    (credName && llmCredentials[credName]) ||
    acfg._db_credential ||
    (credName && credName === brainCredName ? brainCred : undefined);
  if (!cred) return null;
  const model = String(acfg.model ?? cred.default_model ?? '');
  if (!model) return null;
  const protocol = acfg.protocol === 'chat_input_audio' ? 'chat_input_audio' : AUDIO_PROTOCOL_DEFAULT;
  return { cred, model, protocol };
}

async function fetchAudio(url: string, maxBytes: number): Promise<{ data: ArrayBuffer; blob: Blob; mime: string; bytes: number }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(AUDIO_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`音频下载失败（HTTP ${r.status}）`);
  const mime = String(r.headers.get('content-type') ?? 'audio/webm').split(';')[0]!.trim() || 'audio/webm';
  const ab = await r.arrayBuffer();
  if (ab.byteLength > maxBytes) throw new Error(`音频过大（${ab.byteLength} bytes > ${maxBytes} bytes）`);
  return { data: ab, blob: new Blob([ab], { type: mime }), mime, bytes: ab.byteLength };
}

function readChatCompletionText(data: Record<string, unknown>): string {
  const choices = Array.isArray(data['choices']) ? data['choices'] : [];
  const first = choices[0];
  if (!first || typeof first !== 'object') return '';
  const message = (first as Record<string, unknown>)['message'];
  if (!message || typeof message !== 'object') return '';
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return String((part as Record<string, unknown>)['text'] ?? '');
    })
    .join('')
    .trim();
}

/** OpenAI-compatible ASR。失败不抛给主链路，返回 ok=false + 可回流给模型的文本。 */
export async function transcribeAudio(opts: {
  cred: ResolvedCredential;
  model: string;
  protocol?: AudioProtocol;
  audioUrl: string;
  index?: number;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<SpeechResult & { bytes?: number; mime?: string }> {
  try {
    const maxBytes = Math.max(1024, Math.min(Number(opts.maxBytes ?? AUDIO_MAX_BYTES_DEFAULT) || AUDIO_MAX_BYTES_DEFAULT, 50 * 1024 * 1024));
    const audio = await fetchAudio(opts.audioUrl, maxBytes);
    const protocol = opts.protocol ?? AUDIO_PROTOCOL_DEFAULT;
    const baseUrl = opts.cred.base_url.replace(/\/+$/, '');
    const resp = protocol === 'chat_input_audio'
      ? await fetch(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.cred.api_key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: opts.model,
            stream: false,
            messages: [{
              role: 'user',
              content: [{
                type: 'input_audio',
                input_audio: {
                  data: `data:${audio.mime};base64,${Buffer.from(audio.data).toString('base64')}`,
                },
              }],
            }],
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? AUDIO_TIMEOUT_MS),
        })
      : await (() => {
          const fd = new FormData();
          fd.set('model', opts.model);
          fd.set('file', audio.blob, audioFilename(opts.audioUrl, opts.index ?? 0));
          return fetch(baseUrl + '/audio/transcriptions', {
            method: 'POST',
            headers: { authorization: `Bearer ${opts.cred.api_key}` },
            body: fd,
            signal: AbortSignal.timeout(opts.timeoutMs ?? AUDIO_TIMEOUT_MS),
          });
        })();
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return { ok: false, text: `语音转写失败（HTTP ${resp.status}）：${t.slice(0, 200)}`, bytes: audio.bytes, mime: audio.mime };
    }
    const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
    const text = protocol === 'chat_input_audio'
      ? readChatCompletionText(data)
      : String(data['text'] ?? '').trim();
    return { ok: !!text, text: text || '（语音模型返回空内容）', bytes: audio.bytes, mime: audio.mime };
  } catch (e) {
    const isTimeout = (e as Error)?.name === 'TimeoutError';
    return { ok: false, text: isTimeout ? `语音转写超时（${opts.timeoutMs ?? AUDIO_TIMEOUT_MS}ms）` : `语音转写失败：${String(e).slice(0, 200)}` };
  }
}
