import { cancelResponseBody, readResponseBody } from '../../core/platform/http-body';
import type { ResolvedLlmCredential } from '../../core/runtime/credential-resolver';
import { MAX_CONTEXT_WINDOW_TOKENS } from './contracts';

export type ModelContextSpec = { context_window_tokens: number | null; source_url: string | null };
const unknown: ModelContextSpec = { context_window_tokens: null, source_url: null };

function verified(tokens: unknown, source: string): ModelContextSpec {
  return typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens > 0 && tokens <= MAX_CONTEXT_WINDOW_TOKENS
    ? { context_window_tokens: tokens, source_url: source } : unknown;
}

// Metadata GETs only. No caller-provided destination, cross-origin redirects or generation probes.
async function catalog(url: string, fetcher: typeof fetch, token?: string): Promise<Record<string, unknown> | null> {
  const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(3000),
    headers: token ? { accept: 'application/json', authorization: `Bearer ${token}` } : { accept: 'application/json' } });
  if (!response.ok) { cancelResponseBody(response); return null; }
  const json = JSON.parse(new TextDecoder().decode(await readResponseBody(response, 512 * 1024)));
  return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
}

/** Verified combined input and output window of the actual invocation route. */
export async function providerModelContext(credential: ResolvedLlmCredential | null, model: string, fetcher: typeof fetch = fetch): Promise<ModelContextSpec> {
  if (!credential) return unknown;
  try {
    const base = new URL(credential.base_url);
    if (base.username || base.password || base.search || base.hash) return unknown;
    const route = base.href.replace(/\/$/, '');
    if (route === 'https://tokenhub.tencentmaas.com/v1' && model === 'deepseek/deepseek-flash') {
      // TokenHub documents this exact direct-supply alias as V4.1-Flash-1017. DeepSeek's
      // /models reference gives its 1M combined window as 1048576 (verified 2026-11-23).
      return verified(1048576, 'https://cloud.tencent.com/document/product/1823/130051');
    }
    if (route === 'https://dashscope.aliyuncs.com/compatible-mode/v1' && model === 'qwen3.8-max') {
      return verified(1000000, 'https://help.aliyun.com/zh/model-studio/qwen3-8-max');
    }
    if (route === 'https://api.deepseek.com' || route === 'https://api.deepseek.com/v1') {
      const result = await catalog('https://api.deepseek.com/models', fetcher, credential.api_key);
      if (result?.object !== 'list' || !Array.isArray(result.data)) return unknown;
      const matches = result.data.filter(row => row?.object === 'model' && row.id === model);
      return matches.length === 1 ? verified(matches[0].context_window, 'https://api-docs.deepseek.com/zh-cn/api/list-models/') : unknown;
    }
    if (route === 'https://openrouter.ai/api/v1' && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)) {
      const url = `https://openrouter.ai/api/v1/models/${model.split('/').map(encodeURIComponent).join('/')}/endpoints`;
      const result = await catalog(url, fetcher);
      const data = result?.data as { id?: string; endpoints?: { model_id?: string; context_length?: number }[] } | undefined;
      if (data?.id !== model || !Array.isArray(data.endpoints) || !data.endpoints.length) return unknown;
      // Fallback routing can switch providers. Advertise a value only when every endpoint agrees.
      const window = data.endpoints[0]?.context_length;
      if (data.endpoints.every(endpoint => endpoint?.model_id === model && endpoint.context_length === window)) return verified(window, url);
    }
  } catch { /* An unavailable or malformed directory has no verified limit to suggest. */ }
  return unknown;
}
