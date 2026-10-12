import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createServer as createTcpServer, connect, type AddressInfo, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool, type Pool } from 'mysql2/promise';
import type { AppConfig } from '../core/config/config';
import { migrateBailingHubCoreSchema } from '../infrastructure/schema/core-schema-migrator';
import { UsageRepository } from '../modules/usage/repository';
import { getUsageIdentity } from '../modules/usage/identity';
import { getBillingRepository } from '../modules/usage/billing-repository';
import type { CrashChildInit, CrashPoint, CrashStage } from '../test-support/model-process-crash-child';

// Opt-in destructive tests own a fresh Docker instance, schemas and child processes.
// No deployment configuration, existing SQL server or external model is used.
const enabled = process.env.BAILING_USAGE_PROCESS_CRASH_TEST === '1';
const mysqlImage = 'mysql:8.4@sha256:85b9bf2e29cf836ecb8c2a15a935d4ba0c606631dff1dd79531a11983c638f2a';
const execute = promisify(execFile);
const childPath = fileURLToPath(new URL('../test-support/model-process-crash-child.ts', import.meta.url));
const children = new Set<ChildProcess>();
let containerId: string | undefined, mysqlPort: number;
const mysql = () => ({ host: '127.0.0.1', port: mysqlPort, user: 'root', password: '', connectionLimit: 8 });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function until(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  do { if (await predicate()) return; await delay(20); } while (Date.now() < end);
  throw new Error(message);
}
async function deadline<T>(promise: Promise<T>, message: string, timeoutMs = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  const exit = new Promise<string | null>(resolve => child.once('exit', (_code, signal) => resolve(signal)));
  assert.equal(child.kill('SIGKILL'), true);
  assert.equal(await deadline(exit, 'SIGKILL child did not exit'), 'SIGKILL');
  children.delete(child);
}

before(async () => {
  if (!enabled) return;
  const name = `bailinghub-process-crash-${randomUUID().replaceAll('-', '')}`;
  const started = await execute('docker', ['run', '--detach', '--rm', '--pull=never', '--name', name,
    '--label', 'org.bailinghub.test=model-process-crash', '--memory=768m', '--cpus=2',
    '--publish', '127.0.0.1::3306', '--env', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', '--env', 'MYSQL_ROOT_HOST=%', mysqlImage]);
  containerId = started.stdout.trim();
  assert.match(containerId, /^[a-f0-9]{64}$/);
  const image = await execute('docker', ['inspect', '--format', '{{.Image}}', containerId]);
  const port = await execute('docker', ['port', containerId, '3306/tcp']);
  assert.match(port.stdout.trim(), /^127\.0\.0\.1:\d+$/);
  mysqlPort = Number(port.stdout.trim().split(':')[1]);
  process.stdout.write(`# isolated_fixture ${JSON.stringify({ containerId, name, imageReference: mysqlImage, image: image.stdout.trim(), host: '127.0.0.1', port: mysqlPort })}\n`);
  await until(async () => {
    const pool = createPool(mysql());
    try { await pool.query('SELECT 1'); return true; } catch { return false; } finally { await pool.end(); }
  }, 'Fresh isolated MySQL did not become ready', 60000);
  const versionPool = createPool(mysql());
  try {
    const [version] = await versionPool.query<any[]>('SELECT VERSION() version');
    process.stdout.write(`# isolated_mysql ${JSON.stringify({ version: version[0].version })}\n`);
  } finally { await versionPool.end(); }
});
after(async () => {
  const errors: unknown[] = [];
  for (const result of await Promise.allSettled([...children].map(kill))) {
    if (result.status === 'rejected') errors.push(result.reason);
  }
  if (containerId) {
    let removed = false;
    try {
      const label = await execute('docker', ['inspect', '--format', '{{index .Config.Labels "org.bailinghub.test"}}', containerId]);
      assert.equal(label.stdout.trim(), 'model-process-crash');
      await execute('docker', ['rm', '--force', containerId]);
      removed = true;
    } catch (error) { errors.push(error); }
    process.stdout.write(`# cleanup ${JSON.stringify({ containerId, removed, trackedChildren: children.size, failures: errors.length })}\n`);
  }
  if (errors.length) throw new AggregateError(errors, 'Synthetic process cleanup failed');
});

/** Drops an actual MySQL COMMIT OK packet while preserving the committed database state. */
async function commitAckProxy(target: CrashStage) {
  const observed = gate(), sockets = new Set<Socket>();
  let withheld = false;
  const stageFor = (sql: string): CrashStage | undefined => {
    if (/INSERT INTO bz_usage_billing_requests\(/i.test(sql)) return 'admitted';
    if (/UPDATE bz_usage_billing_requests SET state='dispatch_committed'/i.test(sql)) return 'dispatch';
    if (/UPDATE bz_usage_billing_requests SET state='(?:completed|cancelled)',result_state=/i.test(sql)) return 'result';
    if (/INSERT INTO bz_usage_billing_ledger\(/i.test(sql)) return 'settlement';
    return undefined;
  };
  function packets(socket: Socket, fn: (packet: Buffer, payload: Buffer) => void) {
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUIntLE(0, 3);
        if (buffered.length < length + 4) break;
        const packet = buffered.subarray(0, length + 4);
        buffered = buffered.subarray(length + 4);
        fn(packet, packet.subarray(4));
      }
    });
  }
  const server = createTcpServer(client => {
    const upstream = connect(mysqlPort, '127.0.0.1');
    sockets.add(client); sockets.add(upstream);
    let stage: CrashStage | undefined, dropNext = false, blocked = false;
    for (const socket of [client, upstream]) {
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
      socket.on('close', () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
    }
    packets(client, (packet, payload) => {
      if (payload[0] === 3) { // COM_QUERY; mysql2 query() uses the text protocol.
        // mysql2/MySQL 8.4 negotiate CLIENT_QUERY_ATTRIBUTES even without
        // attributes: parameter_count=0 and parameter_set_count=1 precede SQL.
        const offset = payload[1] === 0 && payload[2] === 1 ? 3 : 1;
        const sql = payload.subarray(offset).toString('utf8');
        if (/^START TRANSACTION/i.test(sql)) stage = undefined;
        stage = stageFor(sql) ?? stage;
        if (/^COMMIT\s*$/i.test(sql) && stage === target && !withheld) dropNext = true;
      }
      upstream.write(packet);
    });
    packets(upstream, (packet, payload) => {
      if (blocked) return;
      if (dropNext) {
        assert.equal(payload[0], 0, 'Target COMMIT must succeed before its acknowledgment is lost');
        blocked = true; withheld = true; observed.release(); return;
      }
      client.write(packet);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, observed: observed.promise,
    close() { for (const socket of sockets) socket.destroy(); server.close(); } };
}

async function fixture() {
  const database = `process_crash_${randomUUID().replaceAll('-', '')}`;
  const dir = mkdtempSync(join(tmpdir(), 'bailinghub-model-process-crash-'));
  const admin = createPool(mysql());
  let pool: Pool | undefined;
  const cleanup: Array<() => unknown | Promise<unknown>> = [() => rmSync(dir, { recursive: true, force: true }), () => admin.end()];
  const providerGate = gate();
  async function dispose() {
    providerGate.release();
    const errors: unknown[] = [];
    for (const release of cleanup.reverse()) { try { await release(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new Error(`Synthetic process fixture cleanup failed (${errors.length})`);
  }
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    cleanup.push(() => admin.query(`DROP DATABASE \`${database}\``));
    await migrateBailingHubCoreSchema({ mysql: { ...mysql(), database }, logger: { log() {}, warn() {} } });
    pool = createPool({ ...mysql(), database });
    const sql = pool;
    cleanup.push(() => sql.end());
    const repository = new UsageRepository(() => sql);
    const provider = { calls: 0, responses: 0 };
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* Synthetic input only. */ }
      provider.calls++;
      await providerGate.promise;
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/v1/chat/completions'
        ? { id: 'synthetic-execution', choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic output' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
        : { id: 'synthetic-execution', data: [{ url: 'https://synthetic.invalid/image.png' }],
          usage: { output_image_count: 1, output_image_type: '1k', output_width: 1024, output_height: 1024 } }));
      provider.responses++;
    });
    cleanup.push(() => { server.close(); server.closeAllConnections(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const config: AppConfig = {
      root: process.cwd(), runtimeRoot: dir, env: 'development', server: { host: '127.0.0.1', port: 0, token: '' }, brand: { name: 'Synthetic process recovery' },
      displayTz: 'Asia/Shanghai', displayTzLabel: '北京时间', auditRetentionDays: 0, alerts: null, metrics: { enabled: false, token: '', scrapeTimeoutMs: 1000 },
      bootstrapAdmin: null, concurrency: 1, killSwitchFile: join(dir, '.paused'), claudeBin: 'synthetic-unused', defaultProfile: 'readonly', brainDir: join(dir, 'brain'),
      state: { backend: 'mysql', jsonlPath: join(dir, 'jobs.jsonl'), mysql: { ...mysql(), database } }, projects: {},
      llmCredentials: { synthetic: { base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api_key: 'REPLACE_ME' } },
      executor: { hubUrl: '', token: '', executorId: 'synthetic', targets: [], waitMs: 100, concurrency: 1, labels: [] },
    };
    for (const kind of ['image', 'chat'] as const) {
      const modelId = `synthetic/${kind}`, endpointId = 'synthetic-provider';
      await sql.query('INSERT INTO bz_usage_price_snapshots VALUES(?,?,?)', [
        createHash('sha256').update(`${kind}:${modelId}`).digest('hex'),
        JSON.stringify({ fetchedAt: Date.now(), items: [{ id: endpointId, pricing: {
          source: 'openrouter', modelId, endpointId, currency: 'USD', fetchedAt: Date.now(),
          lines: kind === 'image' ? [{ billable: 'output_image', unit: 'image', costUsd: '0.2', variant: '1k' }]
            : [{ billable: 'prompt', unit: 'token', costUsd: '0.01' }, { billable: 'completion', unit: 'token', costUsd: '0.01' }],
        } }] }), Date.now(),
      ]);
      await repository.putService({ id: `synthetic-${kind}`, label: `Synthetic ${kind}`, expectedRevision: 0, config: {
        credential: 'synthetic', model: `synthetic-${kind}`, providerScope: database, maxInputBytes: 16384, maxOutputTokens: 100, timeoutMs: 30000,
        purpose: kind === 'image' ? 'tool' : 'chat', pricing: { source: 'openrouter', kind, modelId, endpointId },
        ...(kind === 'image' ? { tool: { name: 'generate_image', capability: 'image_generation', description: 'Synthetic image', outputs: ['image'], adapter: 'aliyun-image',
          parameters: [{ name: 'prompt', type: 'string', required: true, description: 'Synthetic input' }] } } : {}),
      } });
    }
    const identity = getUsageIdentity(repository);
    const issuer = await identity.createIssuer({ id: 'synthetic-product', label: 'Synthetic product', permissions: ['identity:exchange'], service_ids: ['synthetic-image', 'synthetic-chat'] });
    const user = await identity.exchange(issuer.credential!, { request_key: randomUUID(), tenant: 'synthetic', subject: 'synthetic-subject', service_id: 'synthetic-image', model_access: 'token_gateway' });
    const tokens = getBillingRepository(repository);
    await tokens.putPlan({ id: 'synthetic-plan', label: 'Synthetic allowance', expected_revision: 0,
      config: { mode: 'credits', serviceIds: ['synthetic-image', 'synthetic-chat'], priceUsd: 100, multiplier: 1, duration: { unit: 'month', count: 1 } } });
    await tokens.grant(user.session.accountId, { request_key: 'synthetic-grant', plan_id: 'synthetic-plan', expected_revision: 0 });

    async function start(point?: CrashPoint, ack?: CrashStage) {
      const proxy = ack ? await commitAckProxy(ack) : undefined;
      if (proxy) cleanup.push(() => proxy.close());
      const child = spawn(process.execPath, ['--import', 'tsx', childPath], {
        cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.add(child);
      cleanup.push(() => kill(child));
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
      const ready = gate(), fault = gate();
      let base = '', error: Error | undefined;
      child.on('message', message => {
        const value = message as { type: string; base?: string; message?: string; point?: string; pid: number };
        assert.equal(value.pid === undefined || value.pid === child.pid, true);
        if (value.type === 'ready') { base = value.base!; ready.release(); }
        if (value.type === 'fault') { assert.equal(value.point, point); fault.release(); }
        if (value.type === 'error') { error = new Error(value.message); ready.release(); fault.release(); }
      });
      child.once('exit', () => { children.delete(child); if (!base) { error = new Error(`Synthetic Kernel exited before ready: ${stderr}`); ready.release(); } });
      const init: CrashChildInit = { type: 'init', config: { ...config, state: { ...config.state, mysql: { ...config.state.mysql, port: proxy?.port ?? mysqlPort } } }, instanceKey: database, ...(point ? { point } : {}) };
      child.send(init);
      await deadline(ready.promise, 'Synthetic Kernel did not become ready');
      if (error) throw error;
      async function api(path: string, method = 'GET', body?: unknown) {
        const response = await fetch(base + path, { method, signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${user.credential}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() as Record<string, any> };
      }
      const request = (operationId: string, kind: 'image' | 'chat' = 'image') => api(kind === 'image' ? '/usage/v1/model/tools/requests' : '/usage/v1/model/requests', 'POST',
        kind === 'image' ? { operation_id: operationId, service_id: 'synthetic-image', arguments: { prompt: 'Synthetic input' } }
          : { operation_id: operationId, service_id: 'synthetic-chat', messages: [{ role: 'user', content: 'Synthetic input' }] });
      async function stop() {
        const exit = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
        child.send({ type: 'shutdown' });
        assert.equal(await deadline(exit, 'Recovery Kernel did not close'), 0);
      }
      return { child, api, request, stop, fault: proxy?.observed ?? fault.promise };
    }
    const rows = async () => (await sql.query<any[]>('SELECT id,operation_id,state,result_state,billing_state,fence,result_json,result_hash,billed_usd FROM bz_usage_billing_requests'))[0];
    const ledger = async () => (await sql.query<any[]>('SELECT request_id,billed_usd FROM bz_usage_billing_ledger'))[0];
    const consumed = async () => Number((await sql.query<any[]>('SELECT consumed_usd FROM bz_usage_billing_periods'))[0][0]?.consumed_usd ?? 0);
    return { start, rows, ledger, consumed, provider, providerGate, close: dispose };
  } catch (error) { await dispose().catch(() => {}); throw error; }
}

const windows: Array<{ point?: CrashPoint; ack?: CrashStage; label: string; stage: CrashStage; committed: boolean; kind?: 'image' | 'chat' }> = [
  { point: 'admitted:before', label: 'before admission COMMIT', stage: 'admitted', committed: false },
  { point: 'admitted:after', label: 'after admission COMMIT, before dispatch', stage: 'admitted', committed: true },
  { point: 'dispatch:before', label: 'before dispatch COMMIT', stage: 'dispatch', committed: false },
  { point: 'dispatch:after', label: 'after dispatch COMMIT, before provider send', stage: 'dispatch', committed: true },
  { ack: 'dispatch', label: 'dispatch COMMIT OK packet lost', stage: 'dispatch', committed: true },
  { point: 'result:before', label: 'provider response received, before result COMMIT', stage: 'result', committed: false },
  { point: 'result:after', label: 'result COMMIT complete, before settlement', stage: 'result', committed: true },
  { ack: 'result', label: 'result COMMIT OK packet lost', stage: 'result', committed: true },
  { point: 'settlement:before', label: 'before settlement COMMIT', stage: 'settlement', committed: false },
  { ack: 'settlement', label: 'settlement COMMIT OK packet lost', stage: 'settlement', committed: true },
  { point: 'result:after', label: 'chat result committed, HTTP response lost', stage: 'result', committed: true, kind: 'chat' },
];
for (const window of windows) {
  test(`real SIGKILL recovery: ${window.label}`, { skip: !enabled, timeout: 45000 }, async t => {
    const h = await fixture(), operationId = randomUUID(), kind = window.kind ?? 'image';
    try {
      const first = await h.start(window.point, window.ack);
      h.providerGate.release();
      const delivered = first.request(operationId, kind).catch(() => null);
      await deadline(first.fault, `Crash window not reached: ${window.label}`);
      const before = await h.rows();
      const absent = window.stage === 'admitted' && !window.committed;
      const complete = window.stage === 'settlement' || (window.stage === 'result' && window.committed);
      const dispatched = !absent && (window.stage !== 'admitted' && !(window.stage === 'dispatch' && !window.committed));
      assert.equal(before.length, absent ? 0 : 1);
      if (!absent) {
        assert.equal(before[0].operation_id, operationId);
        assert.equal(Boolean(before[0].fence), dispatched);
        assert.equal(before[0].state, complete ? 'completed' : dispatched ? 'dispatch_committed' : 'admitted');
        assert.equal(before[0].result_state, complete ? 'complete' : 'pending');
        assert.equal(before[0].billing_state, window.stage === 'settlement' && window.committed ? 'settled' : 'pending');
        assert.equal(Boolean(before[0].result_hash), complete);
      }
      assert.equal(h.provider.calls, ['result', 'settlement'].includes(window.stage) ? 1 : 0);
      const callsBefore = h.provider.calls;
      assert.equal((await h.ledger()).length, window.stage === 'settlement' && window.committed ? 1 : 0);
      await kill(first.child);
      await delivered;

      const recovery = await h.start();
      assert.notEqual(recovery.child.pid, first.child.pid);
      const replay = await recovery.request(operationId, kind);
      assert.equal(replay.body.operation_id, operationId);
      assert.equal(replay.status, absent || complete ? (kind === 'image' && absent ? 202 : 200) : 202);
      if (!absent) assert.equal((await h.rows())[0].id, before[0].id);
      if (complete) assert.deepEqual(replay.body.response, typeof before[0].result_json === 'string' ? JSON.parse(before[0].result_json) : before[0].result_json);
      if (absent || complete) {
        await until(async () => (await h.rows())[0]?.billing_state === 'settled', 'Saved evidence was not reconciled');
        const after = (await h.rows())[0];
        assert.equal(after.result_state, 'complete'); assert.ok(after.result_hash);
        if (complete) assert.equal(after.result_hash, before[0].result_hash);
        assert.equal(h.provider.calls, 1);
        assert.equal((await h.ledger()).length, 1);
        assert.equal(Number((await h.ledger())[0].billed_usd), kind === 'image' ? 0.2 : 0.02);
        assert.equal(await h.consumed(), kind === 'image' ? 0.2 : 0.02);
        for (let i = 0; i < 3; i++) {
          const again = await recovery.request(operationId, kind);
          assert.equal(again.status, 200); assert.equal(again.body.operation_id, operationId);
        }
        assert.equal((await h.ledger()).length, 1); assert.equal(h.provider.calls, 1);
      } else {
        assert.equal(replay.body.dispatch, dispatched ? 'unknown' : 'not_dispatched');
        assert.equal(replay.body.next_action, 'inspect_original');
        await delay(100);
        assert.equal(h.provider.calls, callsBefore);
        assert.equal((await h.ledger()).length, 0); assert.equal(await h.consumed(), 0);
        if (!dispatched) {
          const cancelled = await recovery.api(`/usage/v1/model/requests/${operationId}/cancel`, 'POST', {});
          assert.equal(cancelled.body.result_state, 'cancelled'); assert.equal(cancelled.body.billing_state, 'settled');
          assert.equal(cancelled.body.billed_usd, 0); assert.equal(h.provider.calls, 0);
        }
      }
      t.diagnostic(JSON.stringify({ window: window.label, killedPid: first.child.pid, recoveredPid: recovery.child.pid,
        signal: 'SIGKILL', providerCallsBefore: callsBefore, providerCallsAfter: h.provider.calls,
        rows: (await h.rows()).length, ledgerRows: (await h.ledger()).length, consumedUsd: await h.consumed() }));
      await recovery.stop();
    } finally { await h.close(); }
  });
}

test('real SIGKILL after provider receipt preserves original pending and never re-dispatches', { skip: !enabled, timeout: 45000 }, async t => {
  const h = await fixture(), operationId = randomUUID();
  try {
    const first = await h.start();
    const accepted = await first.request(operationId);
    assert.equal(accepted.status, 202);
    await until(() => h.provider.calls === 1, 'Synthetic provider did not receive the original request');
    const original = (await h.rows())[0];
    assert.equal(original.state, 'dispatch_committed'); assert.equal(original.result_hash, null);
    await kill(first.child);
    h.providerGate.release();
    const recovery = await h.start();
    assert.notEqual(recovery.child.pid, first.child.pid);
    for (let i = 0; i < 4; i++) {
      const replay = await recovery.request(operationId);
      assert.equal(replay.status, 202); assert.equal(replay.body.operation_id, operationId);
      assert.equal(replay.body.dispatch, 'unknown'); assert.equal(replay.body.next_action, 'inspect_original');
      const read = await recovery.api(`/usage/v1/model/requests/${operationId}`);
      assert.equal(read.status, 200); assert.equal(read.body.dispatch, 'unknown');
    }
    await delay(100);
    assert.equal(h.provider.calls, 1); assert.equal((await h.rows())[0].id, original.id);
    assert.equal((await h.ledger()).length, 0); assert.equal(await h.consumed(), 0);
    t.diagnostic(JSON.stringify({ window: 'provider received, no saved result', killedPid: first.child.pid,
      recoveredPid: recovery.child.pid, signal: 'SIGKILL', replayCount: 4, providerCalls: h.provider.calls, ledgerRows: 0, consumedUsd: 0 }));
    await recovery.stop();
  } finally { await h.close(); }
});
