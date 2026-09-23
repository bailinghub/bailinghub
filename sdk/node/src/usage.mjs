const PREFIX = '/usage/v1';
function key(value, label = 'identifier') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/.test(value)) throw new TypeError(`Invalid ${label}.`);
  return value;
}
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('A request object is required.'); return value; }
function safeCode(value, fallback) { return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,90}$/.test(value) ? value : fallback; }
function publicFeedback(value) {
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(['schema','code','dispatch','retryable','next_action','reset_at','resetAt'].filter(key =>
    ['string','boolean','number'].includes(typeof value[key])).map(key => [key, value[key]]));
}
export class UsageIssuerError extends Error {
  constructor(code, status, outcome, requestKey, feedback) {
    super(`Usage management request failed (${code}).`);
    this.name = 'UsageIssuerError'; this.code = code; this.status = status; this.outcome = outcome;
    this.requestKey = requestKey; if (feedback) this.feedback = feedback;
  }
}
/** Server-only issuer API. Never expose this credential or these methods as model tools. */
export class UsageIssuerClient {
  #baseUrl; #token; #fetch; #timeout;
  constructor({ baseUrl, issuerToken, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new TypeError('A valid Hub URL is required.'); }
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new TypeError('Use HTTPS, or loopback HTTP for development.');
    if (typeof issuerToken !== 'string' || !/^bhu_i_[A-Za-z0-9_-]{43}$/.test(issuerToken)) throw new TypeError('A separate Usage issuer credential is required.');
    if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Invalid transport configuration.');
    this.#baseUrl = url.toString().replace(/\/+$/, ''); this.#token = issuerToken; this.#fetch = fetchImpl; this.#timeout = timeoutMs;
  }
  async #request(method, path, body) {
    if (body !== undefined) { object(body); if (!path.endsWith('/external/users/revoke')) key(body.request_key, 'request_key'); }
    const requestKey = body?.request_key;
    let response;
    try {
      response = await this.#fetch(this.#baseUrl + path, { method,
        headers: { authorization: `Bearer ${this.#token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(this.#timeout) });
    } catch { throw new UsageIssuerError('USAGE_TRANSPORT_UNAVAILABLE', undefined, method === 'GET' ? 'rejected' : 'unknown', requestKey); }
    let data;
    try {
      if (!response.body) throw new Error();
      const reader = response.body.getReader(); const chunks = []; let bytes = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 1_048_576) throw new Error(); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => {}); }
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      object(data);
    } catch { throw new UsageIssuerError(response.status === 404 ? 'USAGE_UNSUPPORTED' : 'USAGE_RESPONSE_INVALID', response.status,
      method === 'GET' || response.status === 404 ? 'rejected' : 'unknown', requestKey); }
    if (!response.ok) throw new UsageIssuerError(safeCode(data.code ?? data.error, response.status === 404 ? 'USAGE_UNSUPPORTED' : 'USAGE_REQUEST_REJECTED'),
      response.status, response.status >= 500 && method !== 'GET' ? 'unknown' : 'rejected', requestKey, publicFeedback(data.feedback));
    return data;
  }
  #accountPath(accountId, action) { return `${PREFIX}/external/billing/accounts/${encodeURIComponent(key(accountId))}/${action}`; }
  exchangeSession(input) { return this.#request('POST', `${PREFIX}/sessions/exchange`, input); }
  revokeUser(input) { return this.#request('POST', `${PREFIX}/external/users/revoke`, input); }
  listBillingPlans() { return this.#request('GET', `${PREFIX}/external/billing/plans`); }
  grantBillingPlan(accountId, input) { return this.#request('POST', this.#accountPath(accountId, 'grant'), input); }
  controlBillingPlan(accountId, input) { return this.#request('POST', this.#accountPath(accountId, 'control'), input); }
  getBillingSummary(accountId) { return this.#request('GET', this.#accountPath(accountId, 'summary')); }
}
