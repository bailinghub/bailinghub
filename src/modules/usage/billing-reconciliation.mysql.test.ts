import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, type RowDataPacket } from 'mysql2/promise';
import { UsageRepository, usageHash } from './repository';
import { BillingRepository, getBillingRepository } from './billing-repository';
import { getUsageIdentity } from './identity';
import { runUsageMaintenanceFor } from './maintenance';
import { createBailingHubKernel } from '../../app/kernel';
import { migrateBailingHubCoreSchema } from '../../infrastructure/schema/core-schema-migrator';
import type { AppConfig } from '../../core/config/config';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
const mysql = { host: '127.0.0.1', port: 16307, user: 'root', password: '', connectionLimit: 8 };
async function fixture() {
  const database = `usage_reconcile_${randomUUID().replaceAll('-', '')}`;
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'bailing-usage-reconcile-'));
  const admin = createPool(mysql);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  let pool: ReturnType<typeof createPool> | undefined;
  const kernels: Array<ReturnType<typeof createBailingHubKernel>> = [];
  const close = async () => {
    for (const kernel of kernels) await kernel.close(5000);
    await pool?.end();
    await admin.query(`DROP DATABASE \`${database}\``); await admin.end();
    await rm(runtimeRoot, { recursive: true, force: true });
  };
  try {
    await migrateBailingHubCoreSchema({ mysql: { ...mysql, database }, logger: { log() {}, warn() {} } });
    await migrateBailingHubCoreSchema({ mysql: { ...mysql, database }, logger: { log() {}, warn() {} } });
    pool = createPool({ ...mysql, database });
    const repository = new UsageRepository(() => pool!), tokens = getBillingRepository(repository), identity = getUsageIdentity(repository);
    const service = await repository.putService({ id: 'synthetic-image', label: 'Synthetic image', expectedRevision: 0,
      config: { credential: 'synthetic-unused', model: 'synthetic', providerScope: database, maxInputBytes: 4096, maxOutputTokens: 100, timeoutMs: 1000 } });
    const issuer = await identity.createIssuer({ id: 'synthetic-issuer', label: 'Synthetic issuer', permissions: ['identity:exchange','identity:revoke'], service_ids: [service.id] });
    const user = await identity.exchange(issuer.credential!, { request_key: randomUUID(), tenant: 'synthetic', subject: 'synthetic-subject', service_id: service.id });
    await tokens.putPlan({ id: 'synthetic-plan', label: 'Synthetic allowance', expected_revision: 0,
      config: { mode: 'credits', serviceIds: [service.id], priceUsd: 100, multiplier: 2, duration: { unit: 'forever', count: 0 } } });
    await tokens.grant(user.session.accountId, { request_key: 'synthetic-grant', plan_id: 'synthetic-plan', expected_revision: 0 });
    const price = { source: 'openrouter' as const, currency: 'USD' as const, modelId: 'synthetic', endpointId: 'synthetic', fetchedAt: Date.now(),
      lines: [{ billable: 'output_image', unit: 'image' as const, costUsd: '0.1' }] };
    async function saved(rawUsage?: Record<string, unknown>, unknown = false, response = { schema: 'synthetic-image', outputs: [{ base64: 'AAAA' }] }) {
      const operationId = randomUUID();
      const admitted = await tokens.admit({ actor: user.session, operationId, serviceId: service.id, conversationId: null, turnId: null,
        requestHash: usageHash([operationId]), expectedServiceRevision: service.revision, serviceConfig: service.config, model: service.config.model, priceSnapshot: price });
      const dispatched = await tokens.commitDispatch(admitted.id, user.session);
      if (unknown) return tokens.markUnknown(admitted.id, dispatched.fence!, 'synthetic_transport_lost');
      return tokens.recordCompletion(admitted.id, dispatched.fence!, { response, ...(rawUsage ? { rawUsage } : {}) });
    }
    async function kernel(schedulerMode: 'managed' | 'standalone' = 'managed') {
      const config: AppConfig = {
        root: process.cwd(), runtimeRoot, env: 'development', server: { host: '127.0.0.1', port: 0, token: '' }, brand: { name: 'Synthetic reconciliation' },
        displayTz: 'Asia/Shanghai', displayTzLabel: '北京时间', auditRetentionDays: 0, alerts: null,
        metrics: { enabled: false, token: '', scrapeTimeoutMs: 1000 }, bootstrapAdmin: null, concurrency: 1,
        killSwitchFile: join(runtimeRoot, '.paused'), claudeBin: 'synthetic-unused', defaultProfile: 'readonly', brainDir: join(runtimeRoot, 'brain'),
        state: { backend: 'mysql', jsonlPath: join(runtimeRoot, 'jobs.jsonl'), mysql: { ...mysql, database } }, projects: {}, llmCredentials: {},
        executor: { hubUrl: '', token: '', executorId: 'synthetic-unused', targets: [], waitMs: 100, concurrency: 1, labels: [] },
      };
      const instance = createBailingHubKernel({ instanceKey: database, config, schedulerMode, bootstrapLocalAdmin: false, logger: { log() {}, warn() {}, error() {} } });
      kernels.push(instance); await instance.initialize(); return instance;
    }
    async function status(id: string) { return (await pool!.query<RowDataPacket[]>('SELECT billing_state,result_state,reference_cost_usd,billed_usd FROM bz_usage_billing_requests WHERE id=?', [id]))[0][0]!; }
    async function ledger() { return Number((await pool!.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM bz_usage_billing_ledger'))[0][0]!.n); }
    return { pool, database, repository, tokens, identity, user, saved, kernel, status, ledger, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}
async function eventually(predicate: () => Promise<boolean>) {
  for (let n = 0; n < 300; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Synthetic reconciliation did not progress');
}
test('MySQL fair pages settle the fifty-first original without reading stored result bodies', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const missing = [];
    for (let n = 0; n < 50; n++) missing.push(await h.saved({ requestCount: 1 }));
    const valid = await h.saved({ requestCount: 1, outputImageCount: 1 }, false, { schema: 'synthetic-image', outputs: [{ base64: 'A'.repeat(4 * 1024 * 1024) }] });
    await h.pool.query('UPDATE bz_usage_billing_requests SET updated_at=? WHERE id<>?', [1, valid.id]);
    await h.pool.query('UPDATE bz_usage_billing_requests SET updated_at=? WHERE id=?', [2, valid.id]);
    await h.tokens.reconcilePendingUsage(); assert.equal(await h.ledger(), 0);
    await h.tokens.reconcilePendingUsage(); assert.equal(await h.ledger(), 1);
    assert.equal((await h.status(valid.id)).billing_state, 'settled');
    assert.equal(Number((await h.status(valid.id)).reference_cost_usd), 0.1);
    assert.equal(Number((await h.status(valid.id)).billed_usd), 0.2); // Original shared multiplier remains 2.
    assert.equal((await h.status(missing[0]!.id)).billing_state, 'pending');
    const [bodies] = await h.pool.query<RowDataPacket[]>("SELECT CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.outputs[0].base64'))) AS bytes FROM bz_usage_billing_requests WHERE id=?", [valid.id]);
    assert.equal(Number(bodies[0]!.bytes), 4 * 1024 * 1024); // Settlement preserved the body without loading it into its scan.
    await h.tokens.reconcilePendingUsage(); assert.equal(await h.ledger(), 1);
    const [indexes] = await h.pool.query<RowDataPacket[]>("SHOW INDEX FROM bz_usage_billing_requests WHERE Key_name='idx_usage_reconciliation_scan'");
    assert.deepEqual(indexes.sort((a,b) => Number(a.Seq_in_index)-Number(b.Seq_in_index)).map(row => row.Column_name), ['billing_state','updated_at','id']);
    const [plan] = await h.pool.query<RowDataPacket[]>("EXPLAIN SELECT id,updated_at FROM bz_usage_billing_requests WHERE billing_state='pending' AND (usage_json IS NOT NULL OR raw_usage_json IS NOT NULL) AND result_hash IS NOT NULL AND fence IS NOT NULL ORDER BY updated_at,id LIMIT 50");
    assert(String(plan[0]!.possible_keys).includes('idx_usage_reconciliation_scan'));
  } finally { await h.close(); }
});
test('revoked identity does not prevent trusted original-evidence settlement; unknown usage remains pending', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const valid = await h.saved({ requestCount: 1, outputImageCount: 1 }), unknown = await h.saved(undefined, true);
    await h.identity.revokeSession(h.user.session);
    await h.tokens.scheduleSettlement(valid.operationId, h.user.session);
    assert.equal((await h.status(valid.id)).billing_state, 'pending');
    await runUsageMaintenanceFor(h.repository);
    assert.equal((await h.status(valid.id)).billing_state, 'settled'); assert.equal(await h.ledger(), 1);
    assert.equal((await h.status(unknown.id)).result_state, 'unknown'); assert.equal((await h.status(unknown.id)).billing_state, 'pending');
  } finally { await h.close(); }
});
test('a temporary scan SQL outage backs off and recovers from persisted evidence without HTTP', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const valid = await h.saved({ requestCount: 1, outputImageCount: 1 });
    const scan = h.tokens.reconcilePendingUsage.bind(h.tokens); let fail = true, attempts = 0;
    h.tokens.reconcilePendingUsage = async () => { attempts++; if (fail) await h.pool.query('SELECT * FROM synthetic_missing_table'); return scan(); };
    await runUsageMaintenanceFor(h.repository, 1); assert.equal((await h.status(valid.id)).billing_state, 'pending');
    fail = false; await runUsageMaintenanceFor(h.repository, 60000); assert.equal(attempts, 1);
    await runUsageMaintenanceFor(h.repository, 60001); assert.equal((await h.status(valid.id)).billing_state, 'settled');
    assert.equal(await h.ledger(), 1);
  } finally { await h.close(); }
});
test('a recreated managed Kernel settles durable evidence using initialize/tick without new HTTP', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const first = await h.kernel(); await first.close(5000);
    const valid = await h.saved({ requestCount: 1, outputImageCount: 1 });
    const restarted = await h.kernel(); await restarted.tick();
    await eventually(async () => (await h.status(valid.id)).billing_state === 'settled');
    assert.equal(await h.ledger(), 1);
  } finally { await h.close(); }
});
test('standalone startup independently reconciles previously saved evidence without HTTP', { skip: !enabled }, async () => {
  const h = await fixture();
  let server: ReturnType<ReturnType<typeof createBailingHubKernel>['createStandaloneServer']> | undefined;
  try {
    const valid = await h.saved({ requestCount: 1, outputImageCount: 1 });
    const kernel = await h.kernel('standalone');
    server = kernel.createStandaloneServer({ exit() {} });
    await server.start(); // The public standalone entry owns timer startup; initialize alone does not.
    await eventually(async () => (await h.status(valid.id)).billing_state === 'settled');
    assert.equal(await h.ledger(), 1);
  } finally { await server?.shutdown('test'); await h.close(); }
});
test('two real Kernels isolate SQL/close blockage and preserve pending evidence for same-owner retry', { skip: !enabled }, async () => {
  const one = await fixture(), two = await fixture();
  const original = BillingRepository.prototype.reconcilePendingUsage;
  let blocked = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  BillingRepository.prototype.reconcilePendingUsage = async function () {
    const [database] = await this.repository.getPool().query<RowDataPacket[]>('SELECT DATABASE() AS name');
    if (database[0]!.name === one.database) { blocked = true; await gate; }
    return original.call(this);
  };
  try {
    const a = await one.saved({ requestCount: 1, outputImageCount: 1 }), b = await two.saved({ requestCount: 1, outputImageCount: 1 });
    const first = await one.kernel(), second = await two.kernel();
    await first.tick(); await second.tick();
    await eventually(async () => blocked);
    await eventually(async () => (await two.status(b.id)).billing_state === 'settled');
    await assert.rejects(first.close(1), /drain timed out/);
    await second.close(5000); assert.equal(await two.ledger(), 1); assert.equal((await one.status(a.id)).billing_state, 'pending');
    release(); await first.close(5000); assert.equal((await one.status(a.id)).billing_state, 'settled'); assert.equal(await one.ledger(), 1);
  } finally { release(); BillingRepository.prototype.reconcilePendingUsage = original; await one.close(); await two.close(); }
});
