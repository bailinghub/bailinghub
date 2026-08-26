import assert from 'node:assert/strict';
import test from 'node:test';
import { ObservabilityLedger } from './config-observability-ledger';

test('ObservabilityLedger 只按 thread/run/Agent Tool target 读取一轮工具候选并显式报告截断', async () => {
  let statement = '';
  let params: unknown[] = [];
  const ledger = new ObservabilityLedger(() => ({
    query: async (sql: string, values: unknown[]) => {
      statement = sql;
      params = values;
      return [[
        { job_id: 'job-1', created_at: '2026-08-26T00:00:01.000Z', updated_at: '2026-08-26T00:00:02.000Z' },
        { job_id: 'job-2', created_at: '2026-08-26T00:00:03.000Z', updated_at: '2026-08-26T00:00:04.000Z' },
        { job_id: 'job-3', created_at: '2026-08-26T00:00:05.000Z', updated_at: '2026-08-26T00:00:06.000Z' },
      ]];
    },
  }));

  const got = await ledger.agentToolJobCandidatesForRun('run-1', 42, 2);
  assert.deepEqual(got.jobs.map((job) => job.job_id), ['job-1', 'job-2']);
  assert.equal(got.truncated, true);
  assert.match(statement, /SELECT \*/);
  assert.match(statement, /thread_id=\?/);
  assert.match(statement, /session_id=\?/);
  assert.match(statement, /target='agent-tool-v1'/);
  assert.deepEqual(params, [42, 'run-1', 3]);
});

test('ObservabilityLedger 批量读取工具审计并按 job 分组', async () => {
  let statement = '';
  let params: unknown[] = [];
  const ledger = new ObservabilityLedger(() => ({
    query: async (sql: string, values: unknown[]) => {
      statement = sql;
      params = values;
      return [[
        { job_id: 'job-1', ts: '2026-08-26T00:00:01.000Z', event: 'tool_call', stage: 'tool', severity: 'info', title: '工具调用', summary: 'a', detail: '{"tool":"a"}' },
        { job_id: 'job-2', ts: '2026-08-26T00:00:02.000Z', event: 'tool_result', stage: 'tool', severity: 'info', title: '工具返回', summary: 'b', detail: '{"tool":"b"}' },
      ]];
    },
  }));

  const got = await ledger.auditsForJobs(['job-1', 'job-2', 'job-1']);
  assert.deepEqual(Object.keys(got), ['job-1', 'job-2']);
  assert.equal(got['job-1']?.[0]?.event, 'tool_call');
  assert.equal(got['job-2']?.[0]?.detail && (got['job-2']![0]!.detail as any).tool, 'b');
  assert.match(statement, /job_id IN \(\?,\?\)/);
  assert.deepEqual(params, ['job-1', 'job-2']);
});
