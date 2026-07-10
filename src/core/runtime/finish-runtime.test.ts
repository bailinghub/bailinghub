// 覆盖：收尾运行时。engine 只负责调用，本模块固定任务终态后的总账、回调、送达和 DLQ 纪律。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryFailureRecipient, finishJob, resultLedgerContent, type FinishRuntimeDeps } from './finish-runtime';
import type { AuditEntry, Job } from '../contracts/types';

function job(extra: Partial<Job> = {}): Job {
  return {
    job_id: 'job-1',
    request_id: 'req-1',
    status: 'running',
    target: 'llm',
    profile: 'default',
    project: '',
    source: 'chat',
    input: '用户输入',
    input_preview: '用户输入',
    thread_id: 7,
    dispatch: { route_name: '测试路由' },
    metadata: {},
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...extra,
  };
}

function deps(updated: Job | null, events: Record<string, unknown[]> = {}): FinishRuntimeDeps {
  const audits: AuditEntry[] = [];
  events['audits'] = audits;
  return {
    store: {
      async updateJob(_jobId, patch) {
        return updated ? { ...updated, ...patch } : null;
      },
      async appendAudit(entry) {
        audits.push(entry);
      },
    },
    conversationLedger: {
      async appendMessage(m) {
        (events['messages'] ??= []).push(m);
      },
    },
    deliveryDlq: {
      async record(d) {
        (events['dlq'] ??= []).push(d);
      },
    },
    now: () => '2026-07-01T00:00:01.000Z',
    async fireCallback(url, j) {
      (events['callbacks'] ??= []).push({ url, job_id: j.job_id, status: j.status });
    },
    async spawnDeliveryJob(j) {
      (events['deliveries'] ??= []).push({ job_id: j.job_id, status: j.status });
    },
    async sendAlert(key, text) {
      (events['alerts'] ??= []).push({ key, text });
    },
    async summarizeThread(j) {
      (events['summaries'] ??= []).push({ job_id: j.job_id });
    },
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('resultLedgerContent: 优先 text，其次 report，最后 raw_result', () => {
  assert.equal(resultLedgerContent(job({ result: { text: '正文', report: { x: 1 } }, raw_result: 'raw' })), '正文');
  assert.equal(resultLedgerContent(job({ result: { report: { x: 1 } }, raw_result: 'raw' })), '{"x":1}');
  assert.equal(resultLedgerContent(job({ result: {}, raw_result: 'raw' })), 'raw');
  assert.equal(resultLedgerContent(job({ result: {} })), '');
});

test('finishJob: done 后写 finished 审计、出站总账、触发摘要、callback 与 delivery', async () => {
  const events: Record<string, unknown[]> = {};
  const original = job({ callback_url: 'https://biz.example.com/cb' });
  const updated = job({ status: 'done', result: { text: '完成了' }, usage: { cost_usd: 0.12 } });

  await finishJob(original, { status: 'done', result: { text: '完成了' }, usage: { cost_usd: 0.12 } }, deps(updated, events));
  await tick();

  assert.equal((events['audits'] as AuditEntry[])[0]?.event, 'finished');
  assert.equal(((events['audits'] as AuditEntry[])[0]?.detail as Record<string, unknown>)['cost_usd'], 0.12);
  assert.deepEqual(events['messages'], [{
    thread_id: 7,
    direction: 'out',
    channel: 'hub',
    job_id: 'job-1',
    content: '完成了',
  }]);
  assert.deepEqual(events['summaries'], [{ job_id: 'job-1' }]);
  assert.deepEqual(events['callbacks'], [{ url: 'https://biz.example.com/cb', job_id: 'job-1', status: 'done' }]);
  assert.deepEqual(events['deliveries'], [{ job_id: 'job-1', status: 'done' }]);
});

test('finishJob: ledger 写入失败也不阻塞 callback 与 delivery', async () => {
  const events: Record<string, unknown[]> = {};
  const d = deps(job({ status: 'done', result: { text: '完成了' } }), events);
  d.conversationLedger = {
    async appendMessage() {
      throw new Error('db down');
    },
  };

  await finishJob(job({ callback_url: 'https://biz.example.com/cb' }), { status: 'done', result: { text: '完成了' } }, d);
  await tick();

  assert.deepEqual(events['summaries'], [{ job_id: 'job-1' }]);
  assert.deepEqual(events['callbacks'], [{ url: 'https://biz.example.com/cb', job_id: 'job-1', status: 'done' }]);
  assert.deepEqual(events['deliveries'], [{ job_id: 'job-1', status: 'done' }]);
});

test('finishJob: error 不写出站总账，但触发 delivery', async () => {
  const events: Record<string, unknown[]> = {};
  await finishJob(job(), { status: 'error', error: 'boom' }, deps(job({ status: 'error', error: 'boom' }), events));
  await tick();

  assert.equal(events['messages'], undefined);
  assert.equal(events['summaries'], undefined);
  assert.deepEqual(events['deliveries'], [{ job_id: 'job-1', status: 'error' }]);
});

test('finishJob: delivery 子任务最终失败时告警并写 DLQ', async () => {
  const events: Record<string, unknown[]> = {};
  const original = job({
    source: 'delivery',
    target: 'wecom-notify',
    input: '投递正文',
    metadata: { to: 'zhangsan' },
  });

  await finishJob(original, { status: 'error', error: '发送失败' }, deps({ ...original, status: 'error', error: '发送失败' }, events));
  await tick();

  assert.deepEqual(events['alerts'], [{
    key: 'delivery_failed_wecom-notify',
    text: '送达任务最终失败（渠道 wecom-notify，收件人 zhangsan）：发送失败。收件人可能未收到结果，请到控制台「任务」查 job-1 并手动补发。',
  }]);
  assert.deepEqual(events['dlq'], [{
    parentJobId: 'job-1',
    channel: 'wecom-notify',
    recipient: 'zhangsan',
    content: '投递正文',
    error: '发送失败',
  }]);
});

test('finishJob: delivery 派生异常只记 delivery_error 审计', async () => {
  const events: Record<string, unknown[]> = {};
  const d = deps(job({ status: 'done', result: { text: '完成' } }), events);
  d.spawnDeliveryJob = async () => {
    throw new Error('delivery down');
  };

  await finishJob(job(), { status: 'done', result: { text: '完成' } }, d);
  await tick();

  const audits = events['audits'] as AuditEntry[];
  assert.equal(audits.some((a) => a.event === 'delivery_error'), true);
});

test('deliveryFailureRecipient: recipient 优先，其次 to，最后问号', () => {
  assert.equal(deliveryFailureRecipient(job({ metadata: { recipient: 'a', to: 'b' } })), 'a');
  assert.equal(deliveryFailureRecipient(job({ metadata: { to: 'b' } })), 'b');
  assert.equal(deliveryFailureRecipient(job({ metadata: {} })), '?');
});
