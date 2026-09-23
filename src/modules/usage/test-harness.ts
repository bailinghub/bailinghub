// Synthetic local-only acceptance fixture. Never reads deployment configuration or real credentials.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createPool } from 'mysql2/promise';
import { send } from '../../app/http';
import { handleAdminUsageApiFor } from '../../routes/admin-usage';
import { UsageRepository } from './repository';
import { getUsageIdentity } from './identity';
import { handleUsageApiFor } from './http';
import { handleModelGatewayApiFor } from './model-gateway';
import { getBillingRepository } from './billing-repository';

export async function createUsageTestHarness() {
  const dbName = `usage_acceptance_${randomUUID().replaceAll('-', '')}`;
  const mysql = { host: '127.0.0.1', port: 16307, user: 'root', password: '', connectionLimit: 8, multipleStatements: true };
  const adminPool = createPool(mysql);
  await adminPool.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  const pool = createPool({ ...mysql, database: dbName });
  for (const file of ['063_usage_model_billing.sql'])
    await pool.query(await readFile(new URL(`../../../sql/${file}`, import.meta.url), 'utf8'));
  const repository = new UsageRepository(() => pool);
  const identity = getUsageIdentity(repository);
  const fixturePrice = {source:'openrouter' as const,modelId:'synthetic/model',endpointId:'synthetic',currency:'USD' as const,fetchedAt:Date.now(),lines:[{billable:'prompt',unit:'token' as const,costUsd:'1'},{billable:'completion',unit:'token' as const,costUsd:'1'}]};
  await pool.query('INSERT INTO bz_usage_price_snapshots VALUES(?,?,?)',[createHash('sha256').update('chat:synthetic/model').digest('hex'),JSON.stringify({fetchedAt:Date.now(),items:[{id:'synthetic',pricing:fixturePrice}]}),Date.now()]);
  const state = { calls: 0, counts: 0, mode: 'ok' as 'ok' | 'missing_usage' | 'error' | 'incomplete' | 'delay' | 'stream' | 'stream_drop' | 'stream_tools_nullable', release: null as (() => void) | null };
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume synthetic input */ }
    if (req.url === '/v1/count-input') { state.counts++; send(res, 200, { input_tokens: 20 }); return; }
    state.calls++;
    if (state.mode === 'error') { send(res, 503, { error: 'synthetic_failure' }); return; }
    if (state.mode === 'incomplete') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"id":"synthetic-incomplete","choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}\n\n'); return;
    }
    if (state.mode === 'stream_tools_nullable') {
      const id = `synthetic-stream-${state.calls}`;
      const frame = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame({ role: 'assistant', reasoning_content: 'Synthetic preview', tool_calls: null }));
      res.write(frame({ content: null, tool_calls: [{ index: 0, id: 'call-original', type: 'function', function: { name: 'inspect_product', arguments: null } }] }));
      res.write(frame({ role: null, tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: '{"id":7}' } }] }));
      res.write(frame({ content: null, tool_calls: null }, 'tool_calls'));
      res.end(`data: ${JSON.stringify({ id, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (state.mode === 'stream' || state.mode === 'stream_drop') {
      const id = `synthetic-stream-${state.calls}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic preview' }, finish_reason: null }] })}\n\n`);
      if (state.mode === 'stream_drop') { res.end(); return; }
      await new Promise<void>(resolve => { state.release = resolve; });
      res.end(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (state.mode === 'delay') await new Promise<void>(resolve => { state.release = resolve; });
    send(res, 200, { id: `synthetic-result-${state.calls}`, choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic product is available.' }, finish_reason: 'stop' }],
      ...(state.mode === 'missing_usage' ? {} : { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }) });
  }).listen(0, '127.0.0.1'); await once(provider, 'listening');
  const service = await repository.putService({ id: 'synthetic-text', label: 'Synthetic text', expectedRevision: 0,
    config: { pricing: {source:'openrouter',kind:'chat',modelId:'synthetic/model',endpointId:'synthetic'}, credential: 'synthetic', model: 'synthetic-model', providerScope: dbName, maxInputBytes: 16384,
      maxOutputTokens: 100, timeoutMs: 5000 } });
  const issuer = await identity.createIssuer({ id: 'synthetic-product', label: 'Synthetic product', permissions: ['identity:exchange', 'identity:revoke', 'entitlements:write', 'allowance:grant', 'usage:read'], service_ids: [service.id] });
  const cfg = { llmCredentials: { synthetic: { base_url: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, api_key: 'REPLACE_ME' } } };
  let paused = false;
  const hub = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (await handleUsageApiFor({ usage: repository }, req, res, url)) return;
      if (await handleModelGatewayApiFor({ usage: repository, cfg, isPaused: () => paused }, req, res, url)) return;
      if (url.pathname.startsWith('/admin/api/usage')) {
        const role = req.headers.authorization === 'Bearer synthetic-admin' ? 'admin' : 'usage_auditor';
        await handleAdminUsageApiFor(repository, req.method ?? 'GET', url.pathname, req, res, { kind: 'admin', via: 'session', role }); return;
      }
      send(res, 404, { error: 'not_found' });
    } catch { send(res, 500, { error: 'synthetic_harness_error' }); }
  }).listen(0, '127.0.0.1'); await once(hub, 'listening');
  const baseUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  async function request(path: string, token: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  async function seedUser(options: { grant?: boolean } = {}) {
    const subject = randomUUID();
    const exchange = await request('/usage/v1/sessions/exchange', issuer.credential!, 'POST', { request_key: subject, tenant: 'synthetic', subject, service_id: service.id });
    if (exchange.status !== 200) throw new Error(`Synthetic exchange failed: ${exchange.body.error}`);
    const accountId = exchange.body.session.accountId;
    if (options.grant !== false) {
      const tokens = getBillingRepository(repository);
      await tokens.putPlan({ id: subject, label: 'Synthetic allowance', expected_revision: 0, config: {
        mode: 'credits', serviceIds: [service.id], priceUsd: 1_000_000, multiplier: 1, duration: { unit: 'month', count: 1 } } });
      await tokens.grant(accountId, { request_key: subject, plan_id: subject, expected_revision: 0 });
    }
    return { token: exchange.body.credential as string, actor: exchange.body.session, accountId, subject, sourceId: subject };
  }
  return { repository, identity, pool, state, service, tokens: getBillingRepository(repository), issuerToken: issuer.credential!, baseUrl, request, seedUser,
    setPaused(value: boolean) { paused = value; },
    async close() {
      state.release?.(); hub.close(); hub.closeAllConnections(); provider.close(); provider.closeAllConnections();
      await getBillingRepository(repository).drainSettlements();
      await pool.end();
      // Only the random database created by this fixture is removed; no shared or configured DB is touched.
      await adminPool.query(`DROP DATABASE \`${dbName}\``); await adminPool.end();
    } };
}
