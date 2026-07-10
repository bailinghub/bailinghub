import type { Credential } from '../contracts/types';

export type CredentialVerifyCapability = 'chat' | 'vision' | 'embedding';

export interface CredentialVerifyInput {
  credential: Pick<Credential, 'base_url' | 'api_key' | 'default_model'>;
  capability: CredentialVerifyCapability;
  model?: string;
  timeout_ms?: number;
}

export interface CredentialVerifyResult {
  ok: boolean;
  capability: CredentialVerifyCapability;
  model: string;
  endpoint: string;
  status?: number;
  duration_ms: number;
  message: string;
}

const TEST_IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAASUlEQVR4nGP8//8/Ay0BE01NZxi1YDBYwIIp5LArkBITD7itH15BxDRqASEwagFBMGoBQTBqAUEwagFBMGoBQcA42nQkBIa+BQBlmQk7hoIYYQAAAABJRU5ErkJggg==';

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function textOfContent(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map((x) => typeof x?.text === 'string' ? x.text : '').join('').trim();
  return '';
}

function parseErrorText(raw: string): string {
  try {
    const d = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown }; message?: unknown };
    const code = d.error?.code ? String(d.error.code) : '';
    const msg = d.error?.message ?? d.message;
    return [code, msg ? String(msg) : ''].filter(Boolean).join(': ') || raw;
  } catch {
    return raw;
  }
}

function result(input: {
  ok: boolean;
  capability: CredentialVerifyCapability;
  model: string;
  endpoint: string;
  status?: number;
  started: number;
  message: string;
}): CredentialVerifyResult {
  return {
    ok: input.ok,
    capability: input.capability,
    model: input.model,
    endpoint: input.endpoint,
    ...(input.status != null ? { status: input.status } : {}),
    duration_ms: Date.now() - input.started,
    message: input.message.slice(0, 800),
  };
}

export async function verifyCredentialConnection(
  input: CredentialVerifyInput,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialVerifyResult> {
  const capability = input.capability;
  const model = String(input.model ?? input.credential.default_model ?? '').trim();
  const timeoutMs = Math.max(1000, Math.min(Number(input.timeout_ms ?? 30000) || 30000, 120000));
  const path = capability === 'embedding' ? '/embeddings' : '/chat/completions';
  const url = endpoint(input.credential.base_url, path);
  const started = Date.now();
  if (!model) {
    return result({ ok: false, capability, model: '', endpoint: path, started, message: '验证模型必填：请填写默认模型或在验证窗口指定模型' });
  }

  const body = capability === 'embedding'
    ? { model, input: 'bailing credential health check' }
    : {
        model,
        stream: false,
        messages: [
          capability === 'vision'
            ? {
                role: 'user',
                content: [
                  { type: 'text', text: '如果你能读取这张验证图片，请只回复 OK。' },
                  { type: 'image_url', image_url: { url: TEST_IMAGE_DATA_URL } },
                ],
              }
            : { role: 'user', content: 'Reply with exactly OK.' },
        ],
      };

  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${input.credential.api_key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await resp.text();
    if (!resp.ok) {
      return result({
        ok: false,
        capability,
        model,
        endpoint: path,
        status: resp.status,
        started,
        message: `HTTP ${resp.status}: ${parseErrorText(raw).slice(0, 500)}`,
      });
    }

    let data: any = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { /* 非 JSON 由下面判空 */ }
    if (capability === 'embedding') {
      const vector = data?.data?.[0]?.embedding;
      const dim = Array.isArray(vector) ? vector.length : 0;
      return result({
        ok: dim > 0,
        capability,
        model,
        endpoint: path,
        status: resp.status,
        started,
        message: dim > 0 ? `向量接口可达，维度 ${dim}` : '接口返回成功，但没有拿到 embedding 向量',
      });
    }

    const content = textOfContent(data?.choices?.[0]?.message?.content);
    return result({
      ok: !!content,
      capability,
      model,
      endpoint: path,
      status: resp.status,
      started,
      message: content ? `模型接口可达，返回：${content.slice(0, 120)}` : '接口返回成功，但模型回复为空',
    });
  } catch (e) {
    const name = (e as Error)?.name;
    return result({
      ok: false,
      capability,
      model,
      endpoint: path,
      started,
      message: name === 'TimeoutError' ? `请求超时（${timeoutMs}ms）` : `请求失败：${String(e).slice(0, 500)}`,
    });
  }
}
