import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const sha256hex = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');
const hmacHex = (secret, msg) => createHmac('sha256', secret).update(msg, 'utf8').digest('hex');
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const eq = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function signToolCall(secret, { ts, method, pathWithQuery, body = '', onBehalfOf = '', jobId = '' }) {
  return `sha256=${hmacHex(secret, `${ts}.${String(method).toUpperCase()}.${pathWithQuery}.${sha256hex(body)}.${onBehalfOf}.${jobId}`)}`;
}

export function verifyToolCall(secret, { method, pathWithQuery, body = '', timestamp, signature, onBehalfOf = '', jobId = '', windowSec = 300 }) {
  if (!signature || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) >= windowSec) return false;
  return eq(signToolCall(secret, { ts: timestamp, method, pathWithQuery, body, onBehalfOf, jobId }), signature);
}

export function verifyCallback(secret, { rawBody, timestamp, signature, windowMs = 300_000 }) {
  if (!signature || Math.abs(Date.now() - Number(timestamp)) >= windowMs) return false;
  return eq(`sha256=${hmacHex(secret, `${timestamp}.${rawBody}`)}`, signature);
}

export function signTicket(clientToken, uid, { ttlSeconds = 7200, expiresAt } = {}) {
  const subject = String(uid ?? '');
  if (!subject || Buffer.byteLength(subject, 'utf8') > 64) throw new Error('uid 长度需 1~64 字节');
  const exp = expiresAt ?? Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = b64url(JSON.stringify({ uid: subject, exp }));
  return `v1.${payload}.${hmacHex(clientToken, payload)}`;
}

export function authzProbeResponse(secret, req, authorize) {
  const ok = verifyToolCall(secret, req);
  if (!ok) return { status: 401, body: { authorized: false, error: 'bad_signature' } };
  let subject = req.onBehalfOf || '';
  try {
    const parsed = req.body ? JSON.parse(req.body) : {};
    if (parsed && typeof parsed.subject === 'string') subject = parsed.subject;
  } catch {
    subject = req.onBehalfOf || '';
  }
  let authorized = false;
  try { authorized = !!authorize(subject); } catch { authorized = false; }
  return { status: 200, body: { authorized } };
}

export function param(name, opts = {}) {
  return { name, ...opts };
}

export function tool(opts) {
  if (!opts?.description) throw new Error('tool.description 必填');
  if (!opts?.scope) throw new Error('tool.scope 必填');
  if (!opts?.path?.startsWith('/')) throw new Error('tool.path 必须以 / 开头');
  return {
    description: opts.description,
    scope: opts.scope,
    path: opts.path,
    method: String(opts.method || 'GET').toUpperCase(),
    name: opts.name,
    risk: opts.risk || 'low',
    confirm: !!opts.confirm,
    confirmWhen: opts.confirmWhen || [],
    readonly: opts.readonly,
    requiresSubject: !!opts.requiresSubject,
    idempotent: opts.idempotent,
    sensitive: !!opts.sensitive,
    rateLimit: opts.rateLimit,
    timeoutMs: opts.timeoutMs,
    whenToUse: opts.whenToUse,
    returns: opts.returns,
    examples: opts.examples || [],
    confirmPrompt: opts.confirmPrompt,
    context: opts.context || [],
    tags: opts.tags || [],
    deprecated: !!opts.deprecated,
    params: opts.params || [],
  };
}

function normalizeRateLimit(value) {
  if (!value) return undefined;
  if (typeof value === 'object' && Number.isFinite(Number(value.count)) && value.window) {
    return { count: Number(value.count), window: String(value.window) };
  }
  const m = String(value).replace(/\s+/g, '').match(/^(\d+)\/(s|sec|second|min|minute|h|hour|d|day)$/i);
  if (!m) return undefined;
  const unit = m[2].toLowerCase();
  const window = unit === 's' || unit === 'sec' || unit === 'second'
    ? '1s'
    : unit === 'h' || unit === 'hour'
      ? '1h'
      : unit === 'd' || unit === 'day'
        ? '1d'
        : '1m';
  return { count: Number(m[1]), window };
}

function buildCapability(t, method) {
  const capability = { version: 1, enabled: true, scope: t.scope };
  if (t.risk && t.risk !== 'low') capability.risk = { level: t.risk };
  if (t.confirm || t.confirmWhen?.length || t.confirmPrompt) {
    capability.approval = {};
    if (t.confirm) capability.approval.required = true;
    if (t.confirmWhen?.length) capability.approval.when = t.confirmWhen;
    if (t.confirmPrompt) capability.approval.prompt = t.confirmPrompt;
  }
  if (t.requiresSubject) capability.subject = { required: true };
  const execution = {};
  if (t.readonly === true && method !== 'GET') execution.readonly = true;
  if (t.idempotent === true && method !== 'GET') execution.idempotent = true;
  const rateLimit = normalizeRateLimit(t.rateLimit);
  if (rateLimit) execution.rate_limit = rateLimit;
  if (t.timeoutMs !== undefined) execution.timeout_ms = t.timeoutMs;
  if (Object.keys(execution).length) capability.execution = execution;
  if (t.sensitive) capability.audit = { sensitive: true };
  const guidance = {};
  if (t.whenToUse) guidance.when_to_use = t.whenToUse;
  if (t.returns) guidance.returns = t.returns;
  if (t.examples?.length) guidance.examples = t.examples;
  if (t.context?.length) guidance.context = t.context;
  if (Object.keys(guidance).length) capability.guidance = guidance;
  return capability;
}

export function buildOpenApiSpec({ title = '业务系统', version = '1.0.0', tools = [], authzProbe } = {}) {
  const paths = {};
  const names = new Set();
  for (const t of tools) {
    const method = String(t.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`${t.name || t.path}: method 不支持 ${method}`);
    const operationId = t.name || defaultName(method, t.path);
    if (names.has(operationId)) throw new Error(`operationId 重复：${operationId}`);
    names.add(operationId);
    const op = {
      operationId,
      summary: t.description,
      'x-agent-capability': buildCapability(t, method),
    };
    if (t.tags?.length) op.tags = t.tags;
    if (t.deprecated) op.deprecated = true;

    const queryParams = [];
    const bodyProps = {};
    const bodyRequired = [];
    for (const p of t.params || []) {
      const schema = { type: p.type || 'string' };
      if (p.description) schema.description = p.description;
      if (p.enum) schema.enum = p.enum;
      if (p.default !== undefined) schema.default = p.default;
      if (p.format) schema.format = p.format;
      if (schema.type === 'array') schema.items = { type: p.itemsType || 'string' };
      const loc = p.in || (method === 'GET' ? 'query' : 'body');
      if (loc === 'query') queryParams.push({ name: p.name, in: 'query', required: !!p.required, schema });
      else {
        bodyProps[p.name] = schema;
        if (p.required) bodyRequired.push(p.name);
      }
    }
    if (queryParams.length) op.parameters = queryParams;
    if (Object.keys(bodyProps).length) {
      op.requestBody = { content: { 'application/json': { schema: { type: 'object', properties: bodyProps, ...(bodyRequired.length ? { required: bodyRequired } : {}) } } } };
    }
    paths[t.path] ||= {};
    paths[t.path][method.toLowerCase()] = op;
  }
  const spec = { openapi: '3.0.0', info: { title, version }, paths };
  if (authzProbe) spec['x-bailing-authz-probe'] = authzProbe;
  return spec;
}

function defaultName(method, path) {
  return `${method.toLowerCase()}_${path}`.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
}

export class HubClient {
  constructor({ baseUrl, token, timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
    if (!baseUrl) throw new Error('baseUrl 必填');
    if (!token) throw new Error('token 必填');
    if (typeof fetchImpl !== 'function') throw new Error('当前运行时没有 fetch，请传入 fetchImpl');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  run({ requestId, route, input, metadata = {}, callbackUrl, waitMs } = {}) {
    return this.post('/run', {
      request_id: requestId,
      route,
      input,
      metadata,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      ...(waitMs !== undefined ? { wait_ms: waitMs } : {}),
    });
  }

  getJob(jobId) {
    return this.get(`/jobs/${encodeURIComponent(jobId)}`);
  }

  send({ requestId, channel, to, text, images, files, card } = {}) {
    return this.post('/send', {
      request_id: requestId,
      channel,
      to,
      text,
      ...(images ? { images } : {}),
      ...(files ? { files } : {}),
      ...(card ? { card } : {}),
    });
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body) {
    return this.request('POST', path, body);
  }

  async request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) {
        const err = new Error(data?.error || data?.message || `HTTP ${res.status}`);
        err.status = res.status;
        err.response = data;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}
