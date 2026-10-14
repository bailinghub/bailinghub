import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../core/config/config';
import { createBailingHubKernel } from './kernel';

test('Kernel close drains detached callback before resource release; timeout permits retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-notification-test-'));
  const cfg: AppConfig = { root: process.cwd(), runtimeRoot: dir, env: 'development',
    server: { host: '127.0.0.1', port: 0, token: 'synthetic-only' }, brand: { name: 'Synthetic' },
    displayTz: 'Asia/Shanghai', displayTzLabel: '北京时间', auditRetentionDays: 0, alerts: null,
    metrics: { enabled: false, token: '', scrapeTimeoutMs: 1000 }, bootstrapAdmin: null,
    concurrency: 1, killSwitchFile: join(dir, '.paused'), claudeBin: 'synthetic-unused', defaultProfile: 'readonly', brainDir: join(dir, 'brain'),
    state: { backend: 'jsonl', jsonlPath: join(dir, 'jobs.jsonl'), mysql: { host: '', port: 3306, database: '', user: '', password: '', connectionLimit: 2 } },
    projects: {}, llmCredentials: {}, executor: { hubUrl: '', token: '', executorId: 'synthetic', targets: [], waitMs: 100, concurrency: 1, labels: [] } };
  const job = { job_id: 'synthetic-notification-job', request_id: 'synthetic-notification-request', status: 'dispatched', target: 'synthetic-executor',
    source: 'test', profile: 'readonly', project: '', input_preview: '', metadata: {}, callback_url: 'https://synthetic.invalid/callback',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  await writeFile(cfg.state.jsonlPath, JSON.stringify({ kind: 'job', job }) + '\n');
  const originalFetch = globalThis.fetch;
  let started!: () => void, release!: () => void, completed = false;
  const startedGate = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async () => { started(); await gate; completed = true; return new Response('', { status: 200 }); };
  const kernel = createBailingHubKernel({ instanceKey: 'notification:test', config: cfg, bootstrapLocalAdmin: false });
  try {
    const req = Readable.from([Buffer.from(JSON.stringify({ job_id: job.job_id, ok: true, output: { text: 'synthetic result' } }))]) as IncomingMessage;
    req.method = 'POST'; req.url = '/executor/result'; req.headers = { host: 'localhost', authorization: 'Bearer synthetic-only' };
    let responseStatus = 0;
    await kernel.handle(req, { writeHead(code: number) { responseStatus = code; }, end() {} } as unknown as ServerResponse, new URL('http://localhost/executor/result'));
    await startedGate;
    assert.equal(responseStatus, 200);
    await assert.rejects(kernel.close(2), /notification background drain timed out/);
    assert.equal(completed, false);
    const pendingClose = kernel.close(1000);
    release(); await pendingClose;
    assert.equal(completed, true);
    const records = (await readFile(cfg.state.jsonlPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.filter(x => x.kind === 'job').at(-1).job.status, 'done');
    assert.equal(records.filter(x => x.kind === 'audit' && x.entry.event === 'callback').length, 1);
    await kernel.close(0);
  } finally {
    release(); await kernel.close(1000); globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true });
  }
});
