import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalLedger } from './config-approval-ledger';

test('ApprovalLedger 批量读取工具审批并按 job 分组', async () => {
  let statement = '';
  let params: unknown[] = [];
  const ledger = new ApprovalLedger(() => ({
    query: async (sql: string, values: unknown[]) => {
      statement = sql;
      params = values;
      return [[{
        id: 7,
        job_id: 'job-2',
        request_id: 'approval-2',
        provider: 'business',
        tool: 'staff_edit',
        scope: 'staff.write',
        risk: 'medium',
        args_hash: 'a'.repeat(64),
        status: 'approved',
        created_at: '2026-08-26T00:00:00.000Z',
      }]];
    },
  }));

  const got = await ledger.forJobs(['job-1', 'job-2', 'job-1']);
  assert.deepEqual(got['job-1'], []);
  assert.equal(got['job-2']?.[0]?.status, 'approved');
  assert.match(statement, /job_id IN \(\?,\?\)/);
  assert.deepEqual(params, ['job-1', 'job-2']);
});
