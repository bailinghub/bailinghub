import { createHash } from 'node:crypto';
import { signToolCall } from '../core/contracts/tools';
import type { ToolDefinition } from '../core/contracts/tool-definition';
import type { ToolProvider } from '../core/contracts/types';

export interface ToolDebugResult {
  ok: boolean;
  blocked?: boolean;
  reason?: string;
  request: {
    method: string;
    url: string;
    path_with_query: string;
    body: string;
    on_behalf_of: string;
    job_id: string;
    headers: Record<string, string>;
    signature_material: {
      timestamp: string;
      method: string;
      path_with_query: string;
      body_sha256: string;
      on_behalf_of: string;
      job_id: string;
    };
  };
  response?: {
    status: number;
    duration_ms: number;
    text: string;
    truncated: boolean;
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function debugInvokeTool(input: {
  provider: ToolProvider;
  tool: ToolDefinition;
  args: Record<string, unknown>;
  onBehalfOf?: string;
  jobId?: string;
  clientAppId?: string;
  allowRisky?: boolean;
  truncateBytes?: number;
}): Promise<ToolDebugResult> {
  const { provider, tool } = input;
  const onBehalfOf = String(input.onBehalfOf ?? '').trim();
  const jobId = String(input.jobId ?? `admin-debug-${Date.now()}`).trim().slice(0, 96);
  const allowRisky = input.allowRisky === true;
  const query = new URLSearchParams();
  const bodyObj: Record<string, unknown> = {};
  const extraHeaders: Record<string, string> = {};
  let path = tool.path;

  for (const [k, v] of Object.entries(input.args ?? {})) {
    if (v === undefined || v === null) continue;
    const where = tool.paramIn[k] ?? (tool.method === 'GET' ? 'query' : 'body');
    if (where === 'path') path = path.replace(new RegExp(`\\{${escapeRegExp(k)}\\}`, 'g'), encodeURIComponent(String(v)));
    else if (where === 'header') extraHeaders[k] = String(v);
    else if (where === 'query') query.set(k, String(v));
    else bodyObj[k] = v;
  }

  const qs = query.toString();
  const pathWithQuery = path + (qs ? `?${qs}` : '');
  const body = tool.method === 'GET' ? '' : JSON.stringify(bodyObj);
  const ts = Math.floor(Date.now() / 1000);
  const signature = signToolCall(provider.secret, ts, tool.method, pathWithQuery, body, onBehalfOf, jobId);
  const headers: Record<string, string> = {
    ...(body ? { 'content-type': 'application/json' } : {}),
    'x-bailing-timestamp': String(ts),
    'x-bailing-signature': signature,
    'x-bailing-job-id': jobId,
    'x-bailing-client': input.clientAppId ?? 'admin-debug',
    ...(onBehalfOf ? { 'x-bailing-on-behalf-of': onBehalfOf } : {}),
    'x-bailing-tool-scope': tool.scope,
    ...extraHeaders,
  };
  const request = {
    method: tool.method,
    url: provider.base_url.replace(/\/+$/, '') + pathWithQuery,
    path_with_query: pathWithQuery,
    body,
    on_behalf_of: onBehalfOf,
    job_id: jobId,
    headers: redactHeaders(headers),
    signature_material: {
      timestamp: String(ts),
      method: tool.method,
      path_with_query: pathWithQuery,
      body_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      on_behalf_of: onBehalfOf,
      job_id: jobId,
    },
  };

  const risky = tool.risk === 'high' || tool.confirmRequired || !!tool.confirmWhen?.length;
  if (risky && !allowRisky) {
    return {
      ok: false,
      blocked: true,
      reason: '该工具会进入审批或高风险车道，调试台默认不直接实调；如需验证签名和参数，请先用低风险只读工具。',
      request,
    };
  }
  if (tool.requiresSubject && !onBehalfOf) {
    return {
      ok: false,
      blocked: true,
      reason: '该工具声明 requires-subject，必须填写操作主体 on_behalf_of 后才能实调。',
      request,
    };
  }

  const started = Date.now();
  const limit = input.truncateBytes ?? 8192;
  let status = 0;
  let text = '';
  try {
    const res = await fetch(request.url, {
      method: tool.method,
      headers,
      body: body || undefined,
      signal: AbortSignal.timeout(tool.timeoutMs || provider.timeout_ms || 10_000),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    text = e instanceof Error ? e.message : String(e);
  }
  return {
    ok: status >= 200 && status < 300,
    request,
    response: {
      status,
      duration_ms: Date.now() - started,
      text: text.slice(0, limit),
      truncated: text.length > limit,
    },
  };
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = k.toLowerCase().includes('signature') ? 'sha256=[REDACTED]' : v;
  }
  return out;
}
