import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from 'mysql2/promise';
import type { AppConfig } from '../core/config/config';
import { migrateBailingHubCoreSchema } from '../infrastructure/schema/core-schema-migrator';
import { UsageRepository } from '../modules/usage/repository';
import { getUsageIdentity } from '../modules/usage/identity';
import { BillingRepository, getBillingRepository } from '../modules/usage/billing-repository';
import { ReferencePricing } from '../modules/usage/pricing';
import type { BillingRequest } from '../modules/usage/billing-contracts';
import { createBailingHubKernel } from './kernel';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  throw new Error(message);
}

/** Fresh loopback schema and synthetic provider; never loads deployment configuration. */
async function fixture(schedulerMode: 'managed' | 'standalone' = 'managed') {
  const database = `kernel_usage_${randomUUID().replaceAll('-', '')}`;
  const dir = mkdtempSync(join(tmpdir(), 'bailinghub-usage-lifecycle-'));
  const mysql = { host: '127.0.0.1', port: Number(process.env.BAILING_USAGE_TEST_MYSQL_PORT ?? 16307), user: 'root', password: '', connectionLimit: 8 };
  const admin = createPool(mysql);
  const providerGate = gate();
  const cleanup: Array<() => void | Promise<unknown>> = [() => rmSync(dir, { recursive: true, force: true }), () => admin.end()];
  async function dispose() {
    providerGate.release();
    let failed = false;
    for (const release of cleanup.reverse()) { try { await release(); } catch { failed = true; } }
    if (failed) throw new Error('Synthetic Kernel fixture cleanup failed');
  }
  try {
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  cleanup.push(() => admin.query(`DROP DATABASE \`${database}\``));
  await migrateBailingHubCoreSchema({ mysql: { ...mysql, database }, logger: { log() {}, warn() {} } });
  const pool = createPool({ ...mysql, database });
  cleanup.push(() => pool.end());
  const repository = new UsageRepository(() => pool);
  const state = { calls: 0 };
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* synthetic input only */ }
    state.calls++;
    await providerGate.promise;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v1/chat/completions'
      ? { id: 'synthetic-original', choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic output' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      : { id: 'synthetic-original', data: [{ url: 'https://synthetic.invalid/image.png' }], usage: { input_image_count: 0, output_image_count: 1, output_image_type: '1k', output_width: 1024, output_height: 1024 } }));
  });
  cleanup.push(() => { provider.close(); provider.closeAllConnections(); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const modelId = 'synthetic/image', endpointId = 'synthetic-provider';
  const price = { source: 'openrouter', modelId, endpointId, currency: 'USD', fetchedAt: Date.now(),
    lines: [{ billable: 'output_image', unit: 'image', costUsd: '0.2', variant: '1k' }] };
  await pool.query('INSERT INTO bz_usage_price_snapshots VALUES(?,?,?)', [
    createHash('sha256').update(`image:${modelId}`).digest('hex'), JSON.stringify({ fetchedAt: Date.now(), items: [{ id: endpointId, pricing: price }] }), Date.now(),
  ]);
  const service = await repository.putService({ id: 'synthetic-image', label: 'Synthetic image', expectedRevision: 0, config: {
    credential: 'synthetic', model: 'synthetic-image', providerScope: database, maxInputBytes: 16384, maxOutputTokens: 100, timeoutMs: 10000,
    purpose: 'tool', pricing: { source: 'openrouter', kind: 'image', modelId, endpointId },
    tool: { name: 'generate_image', capability: 'image_generation', description: 'Synthetic image', outputs: ['image'], adapter: 'aliyun-image',
      parameters: [{ name: 'prompt', type: 'string', required: true, description: 'Synthetic input' }] },
  } });
  const identity = getUsageIdentity(repository);
  const chatModelId = 'synthetic/chat';
  const chat = await repository.putService({ id: 'synthetic-chat', label: 'Synthetic chat', expectedRevision: 0, config: {
    ...service.config, purpose: 'chat', tool: undefined, pricing: { source: 'openrouter', kind: 'chat', modelId: chatModelId, endpointId },
  } });
  await pool.query('INSERT INTO bz_usage_price_snapshots VALUES(?,?,?)', [createHash('sha256').update(`chat:${chatModelId}`).digest('hex'),
    JSON.stringify({ fetchedAt: Date.now(), items: [{ id: endpointId, pricing: { source: 'openrouter', modelId: chatModelId, endpointId, currency: 'USD', fetchedAt: Date.now(),
      lines: [{ billable: 'prompt', unit: 'token', costUsd: '0.01' }, { billable: 'completion', unit: 'token', costUsd: '0.01' }] } }] }), Date.now()]);
  const issuer = await identity.createIssuer({ id: 'synthetic-product', label: 'Synthetic product', permissions: ['identity:exchange'], service_ids: [service.id, chat.id] });
  const user = await identity.exchange(issuer.credential!, { request_key: randomUUID(), tenant: 'synthetic', subject: 'same-subject', service_id: service.id, model_access: 'token_gateway' });
  const tokens = getBillingRepository(repository);
  await tokens.putPlan({ id: 'synthetic-plan', label: 'Synthetic allowance', expected_revision: 0, config: {
    mode: 'credits', serviceIds: [service.id, chat.id], priceUsd: 100, multiplier: 1, duration: { unit: 'month', count: 1 },
  } });
  await tokens.grant(user.session.accountId, { request_key: 'synthetic-grant', plan_id: 'synthetic-plan', expected_revision: 0 });
  const config: AppConfig = {
    root: process.cwd(), runtimeRoot: dir, env: 'development', server: { host: '127.0.0.1', port: 0, token: '' }, brand: { name: 'Synthetic lifecycle test' },
    displayTz: 'Asia/Shanghai', displayTzLabel: '北京时间', auditRetentionDays: 0, alerts: null, metrics: { enabled: false, token: '', scrapeTimeoutMs: 1000 },
    bootstrapAdmin: null, concurrency: 1, killSwitchFile: join(dir, '.paused'), claudeBin: 'synthetic-unused', defaultProfile: 'readonly', brainDir: join(dir, 'brain'),
    state: { backend: 'mysql', jsonlPath: join(dir, 'jobs.jsonl'), mysql: { ...mysql, database } }, projects: {},
    llmCredentials: { synthetic: { base_url: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, api_key: 'REPLACE_ME' } },
    executor: { hubUrl: '', token: '', executorId: 'synthetic', targets: [], waitMs: 100, concurrency: 1, labels: [] },
  };
  const warnings: string[] = [];
  const kernel = createBailingHubKernel({ instanceKey: database, config, schedulerMode, bootstrapLocalAdmin: false,
    logger: { log() {}, warn(message) { warnings.push(message); }, error() {} } });
  cleanup.push(() => kernel.close(5000));
  await kernel.initialize();
  const server = createServer((req, res) => { void kernel.handle(req, res).catch(error => res.destroy(error)); });
  cleanup.push(() => { server.close(); server.closeAllConnections(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function api(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${user.credential}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  const request = (operationId: string) => api('/usage/v1/model/tools/requests', 'POST', { operation_id: operationId, service_id: service.id, arguments: { prompt: 'Synthetic input' } });
  const chatRequest = (operationId: string) => api('/usage/v1/model/requests', 'POST', { operation_id: operationId, service_id: chat.id, messages: [{ role: 'user', content: 'Synthetic input' }] });
  return { kernel, repository, pool, providerGate, state, request, chatRequest, api, warnings, close: dispose };
  } catch (error) { await dispose().catch(() => {}); throw error; }
}

test('Kernel drains detached model completion and late SQL settlement; timeout retains pool for same-instance retry', { skip: !enabled }, async () => {
  const h = await fixture(), operationId = randomUUID(), settlementGate = gate();
  const prototype = BillingRepository.prototype as unknown as { settleRecorded(r: BillingRequest): Promise<BillingRequest> };
  const original = prototype.settleRecorded;
  let entered = false, kernelRepository: UsageRepository | undefined;
  prototype.settleRecorded = async function (this: BillingRepository, r) {
    if (r.operationId === operationId) { entered = true; kernelRepository = this.repository; await settlementGate.promise; }
    return original.call(this, r);
  };
  try {
    const first = await h.request(operationId);
    assert.equal(first.status, 202); assert.equal(first.body.result_state, 'pending');
    await until(() => h.state.calls === 1, 'Synthetic provider did not start');
    await assert.rejects(h.kernel.close(10), /usage background drain timed out/);
    assert.equal((await h.request(operationId)).status, 503);
    h.providerGate.release();
    await until(() => entered, 'Late settlement did not start');
    await assert.rejects(h.kernel.close(0), /usage background drain timed out/);
    assert.ok(kernelRepository); await kernelRepository.getPool().query('SELECT 1');
    const [before] = await h.pool.query<any[]>('SELECT result_state,billing_state FROM bz_usage_billing_requests');
    assert.equal(before[0].result_state, 'complete'); assert.equal(before[0].billing_state, 'pending');
    settlementGate.release();
    await h.kernel.close(2000);
    const [after] = await h.pool.query<any[]>('SELECT result_state,billing_state FROM bz_usage_billing_requests');
    assert.equal(after[0].result_state, 'complete'); assert.equal(after[0].billing_state, 'settled');
    const [ledger] = await h.pool.query<any[]>('SELECT COUNT(*) n FROM bz_usage_billing_ledger');
    assert.equal(Number(ledger[0].n), 1); assert.equal(h.state.calls, 1);
  } finally { settlementGate.release(); prototype.settleRecorded = original; await h.close(); }
});

test('normal model HTTP delivery does not wait for SQL settlement, but Kernel close does', { skip: !enabled }, async () => {
  const h = await fixture(), operationId = randomUUID(), settlementGate = gate();
  const prototype = BillingRepository.prototype as unknown as { settleRecorded(r: BillingRequest): Promise<BillingRequest> };
  const original = prototype.settleRecorded;
  let entered = false;
  prototype.settleRecorded = async function (this: BillingRepository, r) {
    if (r.operationId === operationId) { entered = true; await settlementGate.promise; }
    return original.call(this, r);
  };
  try {
    h.providerGate.release();
    const response = await h.chatRequest(operationId);
    assert.equal(response.status, 200); assert.equal(response.body.result_state, 'complete'); assert.equal(response.body.billing_state, 'pending');
    await until(() => entered, 'Normal model settlement did not start');
    await assert.rejects(h.kernel.close(10), /usage background drain timed out/);
    settlementGate.release(); await h.kernel.close(2000);
    const [rows] = await h.pool.query<any[]>('SELECT billing_state FROM bz_usage_billing_requests');
    assert.equal(rows[0].billing_state, 'settled'); assert.equal(h.state.calls, 1);
  } finally { settlementGate.release(); prototype.settleRecorded = original; await h.close(); }
});

test('failed background settlement retains original result and durable pending without replaying the provider', { skip: !enabled }, async () => {
  const h = await fixture(), operationId = randomUUID();
  const prototype = BillingRepository.prototype as unknown as { settleRecorded(r: BillingRequest): Promise<BillingRequest> };
  const original = prototype.settleRecorded;
  let fail = true;
  prototype.settleRecorded = async function (this: BillingRepository, r) {
    if (r.operationId === operationId && fail) throw new Error('SYNTHETIC_PRIVATE_ERROR_MUST_NOT_BE_LOGGED');
    return original.call(this, r);
  };
  try {
    assert.equal((await h.request(operationId)).status, 202); h.providerGate.release();
    await until(() => h.warnings.some(x => x.includes('usage background settlement failed')), 'Settlement failure was not observed');
    const recovered = await h.request(operationId);
    assert.equal(recovered.status, 200); assert.equal(recovered.body.result_state, 'complete'); assert.equal(recovered.body.billing_state, 'pending');
    assert.equal(h.warnings.join('\n').includes('SYNTHETIC_PRIVATE_ERROR'), false);
    await h.kernel.close(2000); // pending is persisted work for maintenance, not an active provider or retry permit
    const [before] = await h.pool.query<any[]>('SELECT result_hash,billing_state FROM bz_usage_billing_requests');
    assert.ok(before[0].result_hash); assert.equal(before[0].billing_state, 'pending');
    fail = false;
    await getBillingRepository(h.repository).reconcilePendingUsage();
    const [after] = await h.pool.query<any[]>('SELECT billing_state FROM bz_usage_billing_requests');
    const [ledger] = await h.pool.query<any[]>('SELECT COUNT(*) n FROM bz_usage_billing_ledger');
    assert.equal(after[0].billing_state, 'settled'); assert.equal(Number(ledger[0].n), 1); assert.equal(h.state.calls, 1);
  } finally { prototype.settleRecorded = original; await h.close(); }
});

test('standalone shutdown uses the same Kernel background barrier before exit', { skip: !enabled }, async () => {
  const h = await fixture('standalone');
  let exitCode: number | undefined;
  let standalone: ReturnType<typeof h.kernel.createStandaloneServer> | undefined;
  try {
    standalone = h.kernel.createStandaloneServer({ exit(code) { exitCode = code; } });
    await standalone.start();
    assert.equal((await h.request(randomUUID())).status, 202);
    await until(() => h.state.calls === 1, 'Synthetic provider did not start');
    let finished = false;
    const closing = standalone.shutdown('test').then(() => { finished = true; });
    await delay(20);
    assert.equal(finished, false); assert.equal(exitCode, undefined);
    h.providerGate.release(); await closing;
    assert.equal(exitCode, 0);
    const [rows] = await h.pool.query<any[]>('SELECT billing_state FROM bz_usage_billing_requests');
    assert.equal(rows[0].billing_state, 'settled'); assert.equal(h.state.calls, 1);
  } finally { h.providerGate.release(); await standalone?.shutdown('test'); await h.close(); }
});

test('Kernel waits for a real locked completion transaction before pool close', { skip: !enabled }, async () => {
  const h = await fixture(), operationId = randomUUID();
  const lock = await h.pool.getConnection();
  try {
    assert.equal((await h.request(operationId)).status, 202);
    await until(() => h.state.calls === 1, 'Synthetic provider did not start');
    await lock.beginTransaction();
    await lock.query('SELECT id FROM bz_usage_billing_requests WHERE operation_id=? FOR UPDATE', [operationId]);
    h.providerGate.release();
    await assert.rejects(h.kernel.close(20), /usage background drain timed out/);
    const [pending] = await h.pool.query<any[]>('SELECT result_state FROM bz_usage_billing_requests');
    assert.equal(pending[0].result_state, 'pending');
    await lock.rollback();
    await h.kernel.close(2000);
    const [done] = await h.pool.query<any[]>('SELECT result_state,billing_state FROM bz_usage_billing_requests');
    assert.equal(done[0].result_state, 'complete'); assert.equal(done[0].billing_state, 'settled'); assert.equal(h.state.calls, 1);
  } finally { await lock.rollback(); lock.release(); await h.close(); }
});

test('two Kernels with the same original operation ID own separate background work and pools', { skip: !enabled }, async () => {
  const one = await fixture(), operationId = randomUUID();
  let closeTwo: (() => Promise<void>) | undefined;
  try {
    const two = await fixture(); closeTwo = two.close;
    assert.equal((await one.request(operationId)).status, 202); assert.equal((await two.request(operationId)).status, 202);
    await until(() => one.state.calls === 1 && two.state.calls === 1, 'Synthetic providers did not start');
    await assert.rejects(one.kernel.close(10), /usage background drain timed out/);
    one.providerGate.release();
    await one.kernel.close(2000);
    assert.equal(two.kernel.isClosing(), false);
    assert.equal((await two.request(operationId)).status, 202); assert.equal(two.state.calls, 1);
    const [pending] = await two.pool.query<any[]>('SELECT result_state FROM bz_usage_billing_requests');
    assert.equal(pending[0].result_state, 'pending');
    await assert.rejects(two.kernel.close(10), /usage background drain timed out/);
    two.providerGate.release(); await two.kernel.close(2000);
    for (const h of [one, two]) {
      const [rows] = await h.pool.query<any[]>('SELECT COUNT(*) n FROM bz_usage_billing_ledger');
      assert.equal(Number(rows[0].n), 1); assert.equal(h.state.calls, 1);
    }
  } finally { await one.close(); await closeTwo?.(); }
});

test('Kernel tracks response cleanup, reconciliation and reference-price SQL refresh, and stops new maintenance', { skip: !enabled }, async () => {
  const h = await fixture(), cleanupGate = gate(), reconciliationGate = gate(), priceGate = gate();
  const cleanup = BillingRepository.prototype.cleanupExpiredResponses, reconcile = BillingRepository.prototype.reconcilePendingUsage;
  let kernelRepository: UsageRepository | undefined, cleanupEntered = false, reconcileEntered = false, priceCalls = 0;
  BillingRepository.prototype.cleanupExpiredResponses = async function (now) {
    kernelRepository = this.repository; cleanupEntered = true; await cleanupGate.promise; return cleanup.call(this, now);
  };
  BillingRepository.prototype.reconcilePendingUsage = async function () {
    reconcileEntered = true; await reconciliationGate.promise; return reconcile.call(this);
  };
  let refresh: Promise<unknown> | undefined;
  try {
    assert.equal((await h.api('/usage/v1/model/tools')).status, 200);
    await until(() => cleanupEntered && reconcileEntered, 'Gateway maintenance was not registered');
    assert.ok(kernelRepository);
    const pricing = new ReferencePricing(kernelRepository, async () => {
      priceCalls++; await priceGate.promise;
      return new Response(JSON.stringify({ data: { endpoints: [{ tag: 'synthetic', pricing: { prompt: '1', completion: '1' } }] } }), { status: 200 });
    });
    await h.pool.query('INSERT INTO bz_usage_price_snapshots VALUES(?,?,?)', [createHash('sha256').update('chat:synthetic/refresh').digest('hex'),
      JSON.stringify({ fetchedAt: 1, items: [{ id: 'synthetic', pricing: { source: 'openrouter', modelId: 'synthetic/refresh', endpointId: 'synthetic', currency: 'USD', fetchedAt: 1,
        lines: [{ billable: 'prompt', unit: 'token', costUsd: '1' }, { billable: 'completion', unit: 'token', costUsd: '1' }] } }] }), 1]);
    const cached = await pricing.inspect({ source: 'openrouter', kind: 'chat', modelId: 'synthetic/refresh', endpointId: 'synthetic' });
    assert.equal(cached.availability.state, 'ready', 'Stale cached quote returns without waiting for refresh');
    await until(() => priceCalls === 1, 'Reference refresh did not start');
    refresh = pricing.catalog('chat', 'synthetic/refresh', true); // joins the already detached refresh
    await assert.rejects(h.kernel.close(10), /usage background drain timed out/);
    await kernelRepository.getPool().query('SELECT 1');
    await assert.rejects(pricing.catalog('chat', 'synthetic/new-refresh', true), /同步已停止/);
    assert.equal(kernelRepository.backgroundWork.startMaintenance('response-cleanup', async () => { throw new Error('must not run'); }), null);
    cleanupGate.release(); reconciliationGate.release();
    await assert.rejects(h.kernel.close(10), /usage background drain timed out/);
    priceGate.release(); await refresh;
    await h.kernel.close(2000);
    const [saved] = await h.pool.query<any[]>('SELECT snapshot_json FROM bz_usage_price_snapshots WHERE cache_key=?', [createHash('sha256').update('chat:synthetic/refresh').digest('hex')]);
    const snapshot = typeof saved[0].snapshot_json === 'string' ? JSON.parse(saved[0].snapshot_json) : saved[0].snapshot_json;
    assert.equal(saved.length, 1); assert.ok(Number(snapshot.fetchedAt) > 1); assert.equal(priceCalls, 1); assert.equal(h.state.calls, 0);
  } finally {
    cleanupGate.release(); reconciliationGate.release(); priceGate.release(); await refresh?.catch(() => {});
    BillingRepository.prototype.cleanupExpiredResponses = cleanup; BillingRepository.prototype.reconcilePendingUsage = reconcile;
    await h.close();
  }
});

for (const kind of ['response-cleanup', 'usage-reconciliation'] as const) {
  test(`Kernel individually drains gateway ${kind} before closing its pool`, { skip: !enabled }, async () => {
    const h = await fixture(), workGate = gate();
    const cleanup = BillingRepository.prototype.cleanupExpiredResponses, reconcile = BillingRepository.prototype.reconcilePendingUsage;
    let entered = false, kernelRepository: UsageRepository | undefined;
    if (kind === 'response-cleanup') BillingRepository.prototype.cleanupExpiredResponses = async function (now) {
      entered = true; kernelRepository = this.repository; await workGate.promise; return cleanup.call(this, now);
    };
    else BillingRepository.prototype.reconcilePendingUsage = async function () {
      entered = true; kernelRepository = this.repository; await workGate.promise; return reconcile.call(this);
    };
    try {
      assert.equal((await h.api('/usage/v1/model/tools')).status, 200);
      await until(() => entered, 'Gateway background SQL did not start');
      await assert.rejects(h.kernel.close(10), /usage background drain timed out/);
      assert.ok(kernelRepository); await kernelRepository.getPool().query('SELECT 1');
      workGate.release(); await h.kernel.close(2000);
      assert.equal(h.state.calls, 0);
    } finally {
      workGate.release(); BillingRepository.prototype.cleanupExpiredResponses = cleanup; BillingRepository.prototype.reconcilePendingUsage = reconcile;
      await h.close();
    }
  });
}
