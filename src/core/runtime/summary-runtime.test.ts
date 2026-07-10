// 覆盖：滚动摘要运行时。finish 只触发，本模块负责摘要阈值、凭证、LLM 调用、CAS 与并发去重。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampSummaryText, createSummaryRuntime, evictForSummary, shouldSummarizeTail, type SummaryLockStoreLike, type SummaryMessage, type SummaryStoreLike } from './summary-runtime';
import { resolveMemoryConfig } from './memory';
import type { AuditEntry, Job } from '../contracts/types';

function job(extra: Partial<Job> = {}): Job {
  return {
    job_id: 'job-1',
    request_id: 'req-1',
    status: 'done',
    target: 'llm',
    profile: 'default',
    project: '',
    source: 'chat',
    thread_id: 7,
    input_preview: '问题',
    metadata: {},
    dispatch: {
      target_config: { credential: 'main' },
      memory: {
        summary_enabled: true,
        summary_trigger_chars: 500,
        summary_keep_recent: 1,
        summary_max_chars: 200,
      },
    },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...extra,
  };
}

function msg(id: number, content: string): SummaryMessage {
  return { id, direction: 'in', channel: 'chat:demo', content, created_at: '2026-07-01T00:00:00.000Z' };
}

function store(tail: SummaryMessage[], writes: Array<Record<string, unknown>> = []): SummaryStoreLike {
  return {
    async getThreadMemory(threadId) {
      assert.equal(threadId, 7);
      return { summary: '旧摘要', summary_upto_id: 2 };
    },
    async unsummarizedMessages(threadId, afterId) {
      assert.equal(threadId, 7);
      assert.equal(afterId, 2);
      return tail;
    },
    async writeThreadSummary(threadId, summary, newWatermark, expectedWatermark) {
      writes.push({ threadId, summary, newWatermark, expectedWatermark });
      return true;
    },
  };
}

function runtime(opts: {
  summaryStore?: SummaryStoreLike | null;
  lockStore?: SummaryLockStoreLike | null;
  audits?: AuditEntry[];
  resolve?: () => Promise<any>;
  call?: () => Promise<{ text: string; tokens: number }>;
}) {
  const audits = opts.audits ?? [];
  return createSummaryRuntime({
    cfg: { llmCredentials: {} },
    summaryStore: opts.summaryStore,
    lockStore: opts.lockStore,
    lockOwner: 'summary-test',
    lockTtlMs: 10_000,
    auditStore: {
      async appendAudit(entry) {
        audits.push(entry);
      },
    },
    now: () => '2026-07-01T00:00:01.000Z',
    resolveSummaryCredential: opts.resolve ?? (async () => ({
      name: 'main',
      source: 'db',
      credential: { base_url: 'https://db.example.com/v1', api_key: 'key', default_model: 'summary-model' },
    })),
    callLlmText: opts.call ?? (async () => ({ text: '新摘要', tokens: 12 })),
  });
}

test('summary helpers: 阈值、淘汰批和摘要硬截断', () => {
  const cfg = resolveMemoryConfig({ summary_enabled: true, summary_trigger_chars: 500, summary_keep_recent: 1, summary_max_chars: 200 });
  const tail = [msg(3, 'a'.repeat(260)), msg(4, 'b'.repeat(260)), msg(5, 'keep')];
  assert.equal(shouldSummarizeTail(tail, cfg), true);
  assert.deepEqual(evictForSummary(tail, cfg).map((m) => m.id), [3, 4]);
  assert.equal(clampSummaryText('x'.repeat(450), cfg), 'x'.repeat(400));
  assert.equal(shouldSummarizeTail([msg(3, 'short')], cfg), false);
});

test('maybeSummarizeThread: 未配置 store/thread/memory 或摘要未启用时不动作', async () => {
  const audits: AuditEntry[] = [];
  await runtime({ summaryStore: null, audits }).maybeSummarizeThread(job());
  await runtime({ summaryStore: store([msg(3, '1234567890')]), audits }).maybeSummarizeThread(job({ thread_id: undefined }));
  await runtime({ summaryStore: store([msg(3, '1234567890')]), audits }).maybeSummarizeThread(job({ dispatch: {} }));
  await runtime({ summaryStore: store([msg(3, '1234567890')]), audits }).maybeSummarizeThread(job({ dispatch: { memory: { summary_enabled: false } } }));
  assert.deepEqual(audits, []);
});

test('maybeSummarizeThread: 阈值不到时不调用凭证与 LLM', async () => {
  let resolved = false;
  await runtime({
    summaryStore: store([msg(3, 'short'), msg(4, 'keep')]),
    resolve: async () => {
      resolved = true;
      return null;
    },
  }).maybeSummarizeThread(job());
  assert.equal(resolved, false);
});

test('maybeSummarizeThread: 成功摘要并写入水位与审计', async () => {
  const audits: AuditEntry[] = [];
  const writes: Array<Record<string, unknown>> = [];
  await runtime({ summaryStore: store([msg(3, '需要摘要的内容'.repeat(100)), msg(4, '最近保留')], writes), audits })
    .maybeSummarizeThread(job());

  assert.deepEqual(writes, [{ threadId: 7, summary: '新摘要', newWatermark: 3, expectedWatermark: 2 }]);
  assert.equal(audits[0]?.event, 'memory_summarized');
  assert.equal((audits[0]?.detail as Record<string, unknown>)['to_id'], 3);
  assert.equal((audits[0]?.detail as Record<string, unknown>)['model'], 'summary-model');
});

test('maybeSummarizeThread: 无凭证或无模型时记 skipped', async () => {
  const noCred: AuditEntry[] = [];
  await runtime({
    summaryStore: store([msg(3, '需要摘要的内容'.repeat(100)), msg(4, '最近保留')]),
    audits: noCred,
    resolve: async () => null,
  }).maybeSummarizeThread(job());
  assert.equal(noCred[0]?.event, 'memory_summary_skipped');
  assert.equal((noCred[0]?.detail as Record<string, unknown>)['reason'], 'no_credential');

  const noModel: AuditEntry[] = [];
  await runtime({
    summaryStore: store([msg(3, '需要摘要的内容'.repeat(100)), msg(4, '最近保留')]),
    audits: noModel,
    resolve: async () => ({ name: 'main', source: 'db', credential: { base_url: 'x', api_key: 'k' } }),
  }).maybeSummarizeThread(job());
  assert.equal(noModel[0]?.event, 'memory_summary_skipped');
  assert.equal((noModel[0]?.detail as Record<string, unknown>)['reason'], 'no_model');
});

test('maybeSummarizeThread: CAS 竞争失败记 memory_summary_raced', async () => {
  const audits: AuditEntry[] = [];
  const s = store([msg(3, '需要摘要的内容'.repeat(100)), msg(4, '最近保留')]);
  s.writeThreadSummary = async () => false;
  await runtime({ summaryStore: s, audits }).maybeSummarizeThread(job());
  assert.equal(audits[0]?.event, 'memory_summary_raced');
});

test('maybeSummarizeThread: 异常记 memory_summary_error 且释放同线程锁', async () => {
  const audits: AuditEntry[] = [];
  const rt = runtime({
    summaryStore: store([msg(3, '需要摘要的内容'.repeat(100)), msg(4, '最近保留')]),
    audits,
    call: async () => {
      throw new Error('llm down');
    },
  });
  await rt.maybeSummarizeThread(job());
  await rt.maybeSummarizeThread(job());
  assert.equal(audits.filter((a) => a.event === 'memory_summary_error').length, 2);
});

test('maybeSummarizeThread: 同线程并发只跑一个摘要', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rt = runtime({
    summaryStore: store([msg(3, '需要摘要的内容'.repeat(100)), msg(4, '最近保留')]),
    call: async () => {
      calls++;
      await gate;
      return { text: '新摘要', tokens: 1 };
    },
  });
  const p1 = rt.maybeSummarizeThread(job());
  const p2 = rt.maybeSummarizeThread(job());
  release();
  await Promise.all([p1, p2]);
  assert.equal(calls, 1);
});

test('maybeSummarizeThread: 跨实例锁被占用时不重复摘要', async () => {
  let calls = 0;
  let lockAttempts = 0;
  await runtime({
    summaryStore: store([msg(3, '需要摘要的内容'.repeat(100)), msg(4, '最近保留')]),
    lockStore: {
      async acquireRuntimeLock(lockKey, owner, ttlMs) {
        assert.equal(lockKey, 'summary:7');
        assert.equal(owner, 'summary-test');
        assert.equal(ttlMs, 10_000);
        lockAttempts++;
        return false;
      },
      async releaseRuntimeLock() {
        assert.fail('未拿到锁时不应释放');
      },
    },
    call: async () => {
      calls++;
      return { text: '新摘要', tokens: 1 };
    },
  }).maybeSummarizeThread(job());

  assert.equal(lockAttempts, 1);
  assert.equal(calls, 0);
});

test('maybeSummarizeThread: 跨实例锁在异常后也会释放', async () => {
  const released: string[] = [];
  await runtime({
    summaryStore: store([msg(3, '需要摘要的内容'.repeat(100)), msg(4, '最近保留')]),
    lockStore: {
      async acquireRuntimeLock() {
        return true;
      },
      async releaseRuntimeLock(lockKey, owner) {
        released.push(`${lockKey}:${owner}`);
      },
    },
    call: async () => {
      throw new Error('llm down');
    },
  }).maybeSummarizeThread(job());

  assert.deepEqual(released, ['summary:7:summary-test']);
});
