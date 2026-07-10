import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEntry } from '../contracts/types';
import type { RuntimeStateStore } from './state-contracts';
import { AuditFailureTracker, observeAuditFailures } from './audit-observability';

function entry(event = 'tool_call'): AuditEntry {
  return { ts: '2026-07-10T00:00:00.000Z', job_id: 'job-1', request_id: 'req-1', event, detail: {} };
}

test('observeAuditFailures: 成功写入不增加失败计数并保留仓库方法 this', async () => {
  const rawObject = {
    marker: 'store',
    async appendAudit(this: { marker: string }) { assert.equal(this.marker, 'store'); },
    async init(this: { marker: string }) { assert.equal(this.marker, 'store'); },
  };
  const raw = rawObject as unknown as RuntimeStateStore;
  const tracker = new AuditFailureTracker(() => 1_700_000_000_000);
  const store = observeAuditFailures(raw, tracker, { error() { assert.fail('不应输出失败日志'); } });

  await store.init();
  await store.appendAudit(entry());
  assert.deepEqual(tracker.snapshot(), { total: 0, lastFailureAt: null });
});

test('observeAuditFailures: best-effort 调用方吞错前仍统一计数并输出脱敏结构化日志', async () => {
  const raw = {
    async appendAudit() { throw new Error('mysql://user:pass@db password=abc token=xyz api_key=key123 authorization=Bearer bearer123 unavailable'); },
  } as unknown as RuntimeStateStore;
  const logs: string[] = [];
  const tracker = new AuditFailureTracker(() => Date.parse('2026-07-10T08:00:00.000Z'));
  const store = observeAuditFailures(raw, tracker, { error(message) { logs.push(message); } });

  await store.appendAudit(entry()).catch(() => undefined);

  assert.deepEqual(tracker.snapshot(), { total: 1, lastFailureAt: '2026-07-10T08:00:00.000Z' });
  assert.equal(logs.length, 1);
  const log = JSON.parse(logs[0]!) as Record<string, unknown>;
  assert.equal(log.event, 'audit_write_failed');
  assert.equal(log.audit_event, 'tool_call');
  assert.equal(log.failure_count, 1);
  assert.doesNotMatch(String(log.error), /user:pass|=abc|=xyz|key123|bearer123/);
});

test('observeAuditFailures: fail-closed 调用仍收到原始异常', async () => {
  const failure = new Error('write failed');
  const raw = { async appendAudit() { throw failure; } } as unknown as RuntimeStateStore;
  const store = observeAuditFailures(raw, new AuditFailureTracker(), { error() {} });

  await assert.rejects(() => store.appendAudit(entry('approval_decision')), (error) => error === failure);
});
