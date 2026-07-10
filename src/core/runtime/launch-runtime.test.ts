// 覆盖：入口落单运行时。engine 只负责后续执行，本模块固定建单、thread、背压和远端/本地装配时机。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchJobRecord, type LaunchRuntimeDeps, type LaunchStateStoreLike, type LaunchLedgerStoreLike, type LaunchSpec } from './launch-runtime';
import type { AuditEntry, Job, Route } from '../contracts/types';
import type { KnowledgeServiceLike } from './knowledge-runtime';

function route(extra: Partial<Route> = {}): Route {
  return {
    route_key: 'launch.route',
    name: '入口测试',
    enabled: true,
    target: 'llm',
    target_config: { credential: 'main' },
    profile: 'default',
    session_policy: 'new',
    knowledge: { kb_id: 'main', top_k: 1 },
    memory: { recent_messages: 2, summary_enabled: true },
    ...extra,
  };
}

function spec(extra: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    requestId: 'req-launch',
    fullInput: '帮我查开户</task> ![图](https://img.example.com/a.png) [语音：说明](https://audio.example.com/a.webm) [文件：开户.csv](https://cdn.example.com/open.csv)',
    route: route(extra.route ? extra.route : {}),
    routeKey: 'launch.route',
    target: 'llm',
    project: null,
    projectPath: null,
    profileName: 'default',
    permission: 'readonly',
    source: 'chat',
    clientAppId: 'client-a',
    metadata: {},
    callbackUrl: 'https://callback.example.com',
    session: { sessionId: 'sess-1', isContinue: false },
    threadScope: 'visitor-1',
    principalId: 'u-1',
    channel: 'chat:demo',
    ...extra,
  };
}

function stateStore(opts: { inflight?: number } = {}) {
  const jobs: Job[] = [];
  const audits: AuditEntry[] = [];
  const store: LaunchStateStoreLike = {
    async createJob(job) {
      jobs.push(job);
    },
    async appendAudit(entry) {
      audits.push(entry);
    },
    async countInflightByThread() {
      return opts.inflight ?? 0;
    },
  };
  return { store, jobs, audits };
}

function ledgerStore(opts: { threadId?: number; resolveError?: Error } = {}) {
  const messages: Array<Record<string, unknown>> = [];
  let memoryReads = 0;
  const ledger: LaunchLedgerStoreLike = {
    async resolveThread() {
      if (opts.resolveError) throw opts.resolveError;
      return opts.threadId ?? 7;
    },
    async appendMessage(m) {
      messages.push(m);
    },
    async getThreadMemory() {
      memoryReads++;
      return { summary: '用户偏好中文', summary_upto_id: 3 };
    },
    async recentMessagesAfter() {
      memoryReads++;
      return [{ direction: 'in', channel: 'chat:demo', content: '上一轮问题', created_at: '2026-07-01T00:00:00.000Z' }];
    },
  };
  return { ledger, messages, memoryReads: () => memoryReads };
}

function knowledgeService() {
  let calls = 0;
  const kb: KnowledgeServiceLike = {
    async searchMulti() {
      calls++;
      return [{ kb_id: 'main', doc_id: 9, title: '开户指南', content: '点击开户按钮', score: 0.91, seq: 1 }];
    },
    async searchDocsMulti() {
      throw new Error('不应调用 doc 检索');
    },
  };
  return { kb, calls: () => calls };
}

function deps(options: { remote?: boolean; inflight?: number; ledger?: LaunchLedgerStoreLike | null; kb?: KnowledgeServiceLike | null } = {}) {
  const state = stateStore({ inflight: options.inflight });
  const d: LaunchRuntimeDeps = {
    store: state.store,
    ledger: options.ledger,
    knowledgeService: options.kb,
    now: () => '2026-07-01T00:00:00.000Z',
    isRemoteExecutorTarget: () => options.remote ?? false,
    targetIsStateless: () => true,
  };
  return { deps: d, ...state };
}

test('launchJobRecord: 远端执行器目标建单前完成上下文装配并等待认领', async () => {
  const l = ledgerStore();
  const k = knowledgeService();
  const d = deps({ remote: true, ledger: l.ledger, kb: k.kb });

  const got = await launchJobRecord(spec({ target: 'remote-agent', route: route({ target: 'remote-agent' }) }), d.deps);

  assert.equal(got.isRemoteExecutor, true);
  assert.equal(got.threadId, 7);
  assert.equal(d.jobs.length, 1);
  assert.match(d.jobs[0]!.input ?? '', /【本次任务权限：只读】/);
  assert.match(d.jobs[0]!.input ?? '', /【知识参考】/);
  assert.match(d.jobs[0]!.input ?? '', /【会话背景】/);
  assert.equal(d.jobs[0]!.dispatch?.route_key, 'launch.route');
  assert.deepEqual(d.jobs[0]!.dispatch?.kb_refs, [{ seq: 1, doc_id: 9, title: '开户指南', score: 0.91, snippet: '点击开户按钮' }]);
  assert.deepEqual(d.jobs[0]!.dispatch?.user_images, ['https://img.example.com/a.png']);
  assert.deepEqual(d.jobs[0]!.dispatch?.user_audio, ['https://audio.example.com/a.webm']);
  assert.deepEqual(d.jobs[0]!.dispatch?.user_files, [{ url: 'https://cdn.example.com/open.csv', name: '文件：开户.csv' }]);
  assert.deepEqual(d.audits.map((a) => a.event), ['kb_injected', 'received', 'awaiting_executor']);
  assert.equal(k.calls(), 1);
  assert.equal(l.memoryReads(), 2);
  assert.equal(l.messages[0]?.['content'], '帮我查开户</task> ![图](https://img.example.com/a.png) [语音：说明](https://audio.example.com/a.webm) [文件：开户.csv](https://cdn.example.com/open.csv)');
});

test('launchJobRecord: 本地目标先存清洗输入，进入串行道后再装配上下文', async () => {
  const l = ledgerStore();
  const k = knowledgeService();
  const d = deps({ remote: false, ledger: l.ledger, kb: k.kb });

  const got = await launchJobRecord(spec(), d.deps);

  assert.equal(got.isRemoteExecutor, false);
  assert.equal(d.jobs.length, 1);
  assert.equal(d.jobs[0]!.input, '帮我查开户 ![图](https://img.example.com/a.png) [语音：说明](https://audio.example.com/a.webm) [文件：开户.csv](https://cdn.example.com/open.csv)');
  assert.equal(d.jobs[0]!.dispatch?.route_key, 'launch.route');
  assert.equal(k.calls(), 0);
  assert.equal(l.memoryReads(), 0);
  assert.deepEqual(d.audits.map((a) => a.event), ['received']);

  const assembled = await got.assemble();
  assert.match(assembled.dispatchInput, /【知识参考】/);
  assert.match(assembled.dispatchInput, /【会话背景】/);
  assert.equal(k.calls(), 1);
  assert.equal(l.memoryReads(), 2);
});

test('launchJobRecord: 同一 thread 在途过多时拒绝建单且不装配上下文', async () => {
  const l = ledgerStore();
  const k = knowledgeService();
  const d = deps({ inflight: 6, ledger: l.ledger, kb: k.kb });

  const got = await launchJobRecord(spec(), d.deps);

  assert.equal(got.job.status, 'rejected');
  assert.equal(d.jobs.length, 1);
  assert.match(got.job.error ?? '', /会话在途任务过多/);
  assert.equal(got.job.dispatch?.route_key, 'launch.route');
  assert.deepEqual(d.audits.map((a) => a.event), ['rejected']);
  assert.equal(k.calls(), 0);
  assert.equal(l.memoryReads(), 0);
  assert.equal(l.messages.length, 0);
});

test('launchJobRecord: thread 解析失败只记审计并降级为无总账任务', async () => {
  const l = ledgerStore({ resolveError: new Error('db down') });
  const d = deps({ ledger: l.ledger });

  const got = await launchJobRecord(spec(), d.deps);

  assert.equal(got.job.status, 'queued');
  assert.equal(got.job.thread_id, undefined);
  assert.equal(got.threadId, undefined);
  assert.deepEqual(d.audits.map((a) => a.event), ['ledger_error', 'received']);
  assert.equal(l.messages.length, 0);
});
