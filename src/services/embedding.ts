const EMBED_BATCH = 10; // DashScope text-embedding-v3/v4 单请求上限 10 条，按下限走最稳

export interface EmbeddingRequestOptions {
  /** 单个 HTTP 批次的截止时间；不传时保持历史的无 transport 截止时间行为。 */
  requestTimeoutMs?: number;
}

export type EmbeddingRequestErrorKind = 'timeout' | 'http' | 'response' | 'network';

/**
 * Embedding transport 的稳定错误边界。
 *
 * message 只携带错误类别和可公开的 HTTP 状态，避免认证信息、服务地址或响应正文进入日志。
 */
export class EmbeddingRequestError extends Error {
  override readonly name = 'EmbeddingRequestError';

  constructor(
    public readonly kind: EmbeddingRequestErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

function timeoutMsOf(options: EmbeddingRequestOptions): number | undefined {
  const value = options.requestTimeoutMs;
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.max(1, Math.floor(value));
}

function responseError(): EmbeddingRequestError {
  return new EmbeddingRequestError('response', 'embedding API returned an invalid response');
}

function parseEmbeddingItems(value: unknown, expected: number, dim: number): Float32Array[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { data?: unknown }).data)) {
    throw responseError();
  }
  const items = (value as { data: unknown[] }).data;
  if (items.length !== expected) {
    throw responseError();
  }

  const ordered: Array<Float32Array | undefined> = new Array(expected);
  for (const item of items) {
    if (!item || typeof item !== 'object') throw responseError();
    const index = (item as { index?: unknown }).index;
    const embedding = (item as { embedding?: unknown }).embedding;
    if (
      !Number.isInteger(index)
      || Number(index) < 0
      || Number(index) >= expected
      || !Array.isArray(embedding)
      || (dim > 0 && embedding.length !== dim)
    ) {
      throw responseError();
    }
    const position = Number(index);
    if (ordered[position] || !embedding.every((part) => typeof part === 'number' && Number.isFinite(part))) {
      throw responseError();
    }
    ordered[position] = normalize(Float32Array.from(embedding));
  }
  if (ordered.some((item) => item === undefined)) throw responseError();
  return ordered as Float32Array[];
}

/** OpenAI 兼容 /embeddings 调用（每 10 条一批），返回 L2 归一化向量。 */
export async function embedViaApi(
  cred: { base_url: string; api_key: string },
  model: string,
  dim: number,
  texts: string[],
  options: EmbeddingRequestOptions = {},
): Promise<Float32Array[]> {
  const url = `${cred.base_url.replace(/\/$/, '')}/embeddings`;
  const requestTimeoutMs = timeoutMsOf(options);
  const out: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const body: Record<string, unknown> = { model, input: batch };
    if (dim) body['dimensions'] = dim;

    const controller = requestTimeoutMs === undefined ? undefined : new AbortController();
    const timer = controller
      ? setTimeout(() => controller.abort(), requestTimeoutMs)
      : undefined;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.api_key}` },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
      if (!resp.ok) {
        throw new EmbeddingRequestError('http', `embedding API returned HTTP ${resp.status}`, resp.status);
      }

      let payload: unknown;
      try {
        payload = await resp.json();
      } catch {
        if (controller?.signal.aborted) {
          throw new EmbeddingRequestError('timeout', 'embedding request timed out');
        }
        throw responseError();
      }
      out.push(...parseEmbeddingItems(payload, batch.length, dim));
    } catch (error) {
      if (error instanceof EmbeddingRequestError) throw error;
      if (controller?.signal.aborted) {
        throw new EmbeddingRequestError('timeout', 'embedding request timed out');
      }
      throw new EmbeddingRequestError('network', 'embedding request failed');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return out;
}
