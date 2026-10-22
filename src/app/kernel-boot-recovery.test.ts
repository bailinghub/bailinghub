import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { Job } from '../core/contracts/types';
import { JsonlStore } from '../infrastructure/state/state-jsonl';
import { createBailingHubKernel } from './kernel';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(mode: 'standalone' | 'managed') {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-boot-recovery-'));
  const cfg: AppConfig = {
    root: process.cwd(), runtimeRoot: dir, env: 'development',
    server: { host: '127.0.0.1', port: 0, token: '' }, brand: { name: 'Synthetic recovery test' },
    displayTz: 'Asia/Shanghai', displayTzLabel: '北京时间', auditRetentionDays: 0, alerts: null,
    metrics: { enabled: false, token: '', scrapeTimeoutMs: 1000 }, bootstrapAdmin: null,
    concurrency: 1, killSwitchFile: join(dir, '.paused'), claudeBin: 'synthetic-unused',
    defaultProfile: 'readonly', brainDir: join(dir, 'brain'),
    state: { backend: 'jsonl', jsonlPath: join(dir, 'jobs.jsonl'),
      mysql: { host: '', port: 3306, database: '', user: '', password: '', connectionLimit: 2 } },
    projects: {}, llmCredentials: {},
    executor: { hubUrl: '', token: '', executorId: 'synthetic', targets: [], waitMs: 100, concurrency: 1, labels: [] },
  };
  // No adapter is installed for this orphan: recovery can durably requeue it
  // without invoking a model, business API, or other external side effect.
  const orphan: Job = {
    job_id: 'synthetic-orphan', request_id: 'synthetic-recovery', status: 'running', target: 'synthetic-uninstalled',
    source: 'test', profile: 'readonly', project: '', input_preview: '', metadata: {},
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  await writeFile(cfg.state.jsonlPath, JSON.stringify({ kind: 'job', job: orphan }) + '\n');
  const kernel = createBailingHubKernel({ instanceKey: `boot:${mode}`, config: cfg, schedulerMode: mode,
    bootstrapLocalAdmin: false, logger: { log() {}, warn() {}, error() {} } });
  let exits = 0;
  const server = mode === 'standalone' ? kernel.createStandaloneServer({ exit: () => { exits++; } }) : undefined;
  return {
    kernel, cfg, server,
    exits: () => exits,
    async start() {
      if (server) await server.start();
      else {
        await kernel.initialize();
        await delay(2_050);
        await kernel.tick();
      }
    },
    async dispose() {
      await kernel.close(2_000);
      if (server) await server.shutdown('test');
      await rm(dir, { recursive: true, force: true });
    },
  };
}

for (const mode of ['standalone', 'managed'] as const) {
  test(`Kernel ${mode} boot recovery: query and late audit finish before resources close; timeout is retryable`, { timeout: 10_000 }, async t => {
    const h = await fixture(mode);
    const queryEntered = gate(), queryRelease = gate(), auditEntered = gate(), auditRelease = gate(), recoveryFinished = gate();
    const events: string[] = [];
    const list = JsonlStore.prototype.listJobsByStatus;
    const audit = JsonlStore.prototype.appendAudit;
    const update = JsonlStore.prototype.updateJobIfStatus;
    const close = JsonlStore.prototype.close;
    t.mock.method(JsonlStore.prototype, 'listJobsByStatus', async function (this: JsonlStore, ...args: Parameters<typeof list>) {
      if (args[0].includes('queued') && args[0].includes('running')) {
        events.push('query:start'); queryEntered.release(); await queryRelease.promise;
        events.push('query:end');
      }
      return await list.apply(this, args);
    });
    t.mock.method(JsonlStore.prototype, 'appendAudit', async function (this: JsonlStore, ...args: Parameters<typeof audit>) {
      if (args[0].event === 'recovered') { auditEntered.release(); await auditRelease.promise; }
      await audit.apply(this, args);
      if (args[0].event === 'recovered') events.push('audit:written');
    });
    t.mock.method(JsonlStore.prototype, 'updateJobIfStatus', async function (this: JsonlStore, ...args: Parameters<typeof update>) {
      const value = await update.apply(this, args);
      if (args[0] === 'synthetic-orphan' && args[2].status === 'queued') {
        events.push('orphan:requeued'); recoveryFinished.release();
      }
      return value;
    });
    t.mock.method(JsonlStore.prototype, 'close', async function (this: JsonlStore) {
      events.push('resources:close'); await close.call(this);
    });
    try {
      await h.start();
      await queryEntered.promise;
      await assert.rejects(h.kernel.close(5), /(?:boot recovery|managed maintenance) drain timed out/);
      assert.equal(events.includes('resources:close'), false, 'a blocked recovery query still owns its store');
      queryRelease.release(); await auditEntered.promise;
      await assert.rejects(h.kernel.close(5), /(?:boot recovery|managed maintenance) drain timed out/);
      assert.equal(events.includes('resources:close'), false, 'late recovery audit and requeue must settle too');
      const firstClose = h.kernel.close(2_000), secondClose = h.kernel.close(2_000);
      auditRelease.release();
      await Promise.all([firstClose, secondClose]);
      await recoveryFinished.promise;
      await h.kernel.close(0);
      assert.deepEqual(events, ['query:start', 'query:end', 'audit:written', 'orphan:requeued', 'resources:close']);
      const journal = (await readFile(h.cfg.state.jsonlPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(journal.filter(row => row.kind === 'job').at(-1).job.status, 'queued');
      assert.equal(journal.filter(row => row.kind === 'audit' && row.entry.event === 'recovered').length, 1);
    } finally {
      queryRelease.release(); auditRelease.release();
      // The baseline closes too early; allow its detached work to finish before
      // removing the fixture so the red test does not leave background writes.
      await recoveryFinished.promise;
      await h.dispose();
    }
  });
}

test('Kernel standalone boot recovery: failure settles before close and does not prevent an idempotent retry', { timeout: 10_000 }, async t => {
  const h = await fixture('standalone'), entered = gate(), release = gate(), finished = gate();
  let closed = 0;
  const original = JsonlStore.prototype.listJobsByStatus, originalClose = JsonlStore.prototype.close;
  t.mock.method(JsonlStore.prototype, 'listJobsByStatus', async function (this: JsonlStore, ...args: Parameters<typeof original>) {
    if (args[0].includes('queued') && args[0].includes('running')) {
      entered.release(); await release.promise; finished.release(); throw new Error('synthetic recovery query failed');
    }
    return await original.apply(this, args);
  });
  t.mock.method(JsonlStore.prototype, 'close', async function (this: JsonlStore) { closed++; await originalClose.call(this); });
  const errors = t.mock.method(console, 'error', () => {});
  try {
    await h.start(); await entered.promise;
    await assert.rejects(h.kernel.close(5), /boot recovery drain timed out/);
    assert.equal(closed, 0);
    release.release(); await h.kernel.close(2_000); await h.kernel.close(0);
    assert.equal(closed, 1);
    assert.equal(errors.mock.callCount(), 1, 'failed recovery remains observable through its existing error log');
  } finally { release.release(); await finished.promise; await h.dispose(); }
});

test('Kernel standalone close before the boot timer fires cancels recovery permanently', { timeout: 10_000 }, async t => {
  const h = await fixture('standalone');
  let recoveryQueries = 0;
  const original = JsonlStore.prototype.listJobsByStatus;
  t.mock.method(JsonlStore.prototype, 'listJobsByStatus', async function (this: JsonlStore, ...args: Parameters<typeof original>) {
    if (args[0].includes('queued') && args[0].includes('running')) recoveryQueries++;
    return await original.apply(this, args);
  });
  try {
    await h.start(); await h.kernel.close(2_000); await delay(2_050);
    assert.equal(recoveryQueries, 0);
    await h.server!.shutdown('test');
    assert.equal(h.exits(), 1);
  } finally { await h.dispose(); }
});
