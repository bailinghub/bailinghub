// Isolated synthetic test worker. Credentials/configuration arrive over IPC only.
import { createPool } from 'mysql2/promise';
import { ApprovalLedger } from '../infrastructure/config/config-approval-ledger';
import { MysqlStore } from '../infrastructure/state/state-mysql';
import type { AppConfig } from '../core/config/config';

process.once('message', async (input: { mysql: AppConfig['state']['mysql']; approvalId: number;
  jobId: string; requestId: string; stage: 'after-decision' | 'after-queue'; decisionId: string }) => {
  try {
    const pool = createPool({ ...input.mysql, timezone: 'Z' });
    const ledger = new ApprovalLedger(() => pool);
    const store = new MysqlStore(input.mysql, { get: async () => pool, close: async () => pool.end() });
    await store.init();
    await ledger.decideWithContinuation(input.approvalId, 'approved', 'synthetic-operator', {
      decision_id: input.decisionId, source: 'external', auth: 'fixture', mode: 'rerun',
    });
    if (input.stage === 'after-queue') await store.requeueApprovedJobOnce({
      job_id: input.jobId, request_id: input.requestId, approval_id: input.approvalId, decision_key: input.decisionId, decision_id: input.decisionId,
    });
    process.send?.({ stage: input.stage, pid: process.pid }, () => process.kill(process.pid, 'SIGKILL'));
  } catch {
    process.send?.({ error: 'synthetic_worker_failed' }, () => process.exit(1));
  }
});
