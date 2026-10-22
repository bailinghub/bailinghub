import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type { AppConfig } from '../../core/config/config';
import { completeTraceEntry } from '../../core/runtime/trace-runtime';
import type { AuditEntry, Job } from '../../core/contracts/types';
import type { JobOperationalMetricsSnapshot, RuntimeStateStore } from '../../core/state/state-contracts';
import { dt, json, rowToJob } from '../../core/state/state-codec';
import { mysqlJobUpdatePlan } from './state-mysql-update-plan';
import { MysqlPoolOwner, type MysqlPoolResource } from '../mysql/pool-owner';
import type { ApprovalRequeueInput, ApprovalRequeueOutcome } from '../../core/contracts/approval-continuation';
import { approvalRequeuePlan } from '../../core/state/approval-continuation';
import { deliveryRequeuePlan } from '../../core/state/delivery-replay';
import { isOriginalExecutorDelivery, type DeliveryRequeueInput, type DeliveryRequeueOutcome } from '../../core/contracts/delivery-replay';
import { completionMatches, terminalNotifications } from '../../core/state/notification-outbox';
import { insertNotificationEvents, MysqlNotificationOutbox } from './notification-outbox-mysql';

/** mysql 后端：生产状态库。对应 sql/001_init_state.sql 的 bz_ 表。 */
export class MysqlStore implements RuntimeStateStore {
  private pool!: Pool;
  private readonly poolOwner: MysqlPoolResource;
  readonly notificationOutbox = new MysqlNotificationOutbox(() => this.pool);

  constructor(cfg: AppConfig['state']['mysql'], poolOwner?: MysqlPoolResource) {
    this.poolOwner = poolOwner ?? new MysqlPoolOwner(cfg);
  }

  /** Reuses the store's existing pool; readiness never opens a fallback connection. */
  get schemaReadinessDb(): Pool { return this.pool; }

  async init(): Promise<void> {
    this.pool = await this.poolOwner.get();
  }

  async close(): Promise<void> {
    await this.poolOwner.close();
  }

  async findByRequestId(requestId: string): Promise<Job | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_jobs WHERE request_id=? LIMIT 1', [requestId]);
    const found = (rows as Record<string, unknown>[])[0];
    return found ? rowToJob(found) : null;
  }

  async createJob(job: Job): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_jobs (job_id,request_id,status,target,profile,project,source,client_app_id,agent_session_id,on_behalf_of,thread_id,session_id,input_preview,input,dispatch,attempts,run_after,claimed_at,lease_until,report,result,raw_result,`usage`,error,metadata,callback_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        job.job_id, job.request_id, job.status, job.target ?? null, job.profile, job.project, job.source,
        job.client_app_id ?? null, job.agent_session_id ?? null, job.on_behalf_of ?? null, job.thread_id ?? null,
        job.session_id ?? null, job.input_preview, job.input ?? null, json(job.dispatch), job.attempts ?? 0,
        job.run_after ? dt(job.run_after) : null, job.claimed_at ? dt(job.claimed_at) : null, job.lease_until ? dt(job.lease_until) : null,
        json(job.report), json(job.result), job.raw_result ?? null,
        json(job.usage), job.error ?? null, json(job.metadata), job.callback_url ?? null,
        dt(job.created_at), dt(job.updated_at),
      ],
    );
  }

  async updateJob(jobId: string, patch: Partial<Job>): Promise<Job | null> {
    return this.writeJob(jobId, patch);
  }

  async completeJobWithNotifications(original: Job, patch: Partial<Job>, context?: { brandName?: string }): Promise<Job | null> {
    if (!['done', 'error', 'rejected'].includes(String(patch.status))) return null;
    return this.writeTerminalJob(original.job_id, patch, undefined, original, context);
  }

  private async writeTerminalJob(jobId: string, patch: Partial<Job>, expectedStatuses?: Job['status'][], original?: Job,
    context?: { brandName?: string }): Promise<Job | null> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows]: any = await connection.query('SELECT * FROM bz_jobs WHERE job_id=? FOR UPDATE', [jobId]);
      const previous = rows[0] ? rowToJob(rows[0]) : null;
      if (!previous || (expectedStatuses && !expectedStatuses.includes(previous.status)) || (original && !completionMatches(previous, original))) {
        await connection.commit(); return null;
      }
      const update = mysqlJobUpdatePlan(patch, new Date().toISOString());
      await connection.query(`UPDATE bz_jobs SET ${update.assignments.join(',')} WHERE job_id=?`, [...update.values, jobId]);
      const [updatedRows]: any = await connection.query('SELECT * FROM bz_jobs WHERE job_id=?', [jobId]);
      const updated = rowToJob(updatedRows[0]);
      await insertNotificationEvents(connection, terminalNotifications(previous, updated, context));
      await connection.commit();
      return updated;
    } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
    finally { connection.release(); }
  }

  async requeueApprovedJobOnce(input: ApprovalRequeueInput): Promise<ApprovalRequeueOutcome> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM bz_jobs WHERE job_id=? FOR UPDATE', [input.job_id]);
      const row = (rows as any[])[0];
      const plan = approvalRequeuePlan(row ? rowToJob(row) : null, input);
      if (plan.patch) {
        const [approvals] = await conn.query('SELECT status,used_at,job_id,request_id,decision_id FROM bz_tool_approvals WHERE id=? FOR UPDATE', [input.approval_id]);
        const approval = (approvals as any[])[0];
        if (!approval || approval.status !== 'approved' || approval.job_id !== input.job_id || approval.request_id !== input.request_id
          || (approval.decision_id ?? null) !== (input.decision_id ?? null)) { await conn.commit(); return 'conflict'; }
        if (approval.used_at != null) { await conn.commit(); return 'consumed'; }
        const update = mysqlJobUpdatePlan(plan.patch, new Date().toISOString());
        await conn.query(`UPDATE bz_jobs SET ${update.assignments.join(',')},approval_continuation_keys=? WHERE job_id=?`,
          [...update.values, json(plan.patch.approval_continuation_keys), input.job_id]);
      }
      await conn.commit();
      return plan.outcome;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally { conn.release(); }
  }

  async updateJobIfStatus(jobId: string, expectedStatuses: Array<Job['status']>, patch: Partial<Job>): Promise<Job | null> {
    if (!expectedStatuses.length) return null;
    return this.writeJob(jobId, patch, expectedStatuses);
  }

  async requeueDeliveryJobOnce(input: DeliveryRequeueInput): Promise<DeliveryRequeueOutcome> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM bz_jobs WHERE job_id=? FOR UPDATE', [input.job_id]);
      const row = (rows as any[])[0];
      const job = row ? rowToJob(row) : null;
      const plan = deliveryRequeuePlan(job, input);
      if (plan.patch) {
        const [dlqs] = await conn.query('SELECT * FROM bz_delivery_dlq WHERE id=? FOR UPDATE', [input.dlq_id]);
        const dlq = (dlqs as any[])[0];
        if (!dlq || dlq.resolved || dlq.executor_replay_key !== input.replay_key || !isOriginalExecutorDelivery(dlq, job)) {
          await conn.commit(); return 'conflict';
        }
        const update = mysqlJobUpdatePlan(plan.patch, new Date().toISOString());
        await conn.query(`UPDATE bz_jobs SET ${update.assignments.join(',')},delivery_replay_keys=? WHERE job_id=?`,
          [...update.values, json(plan.patch.delivery_replay_keys), input.job_id]);
      }
      await conn.commit();
      return plan.outcome;
    } catch (error) {
      await conn.rollback().catch(() => undefined); throw error;
    } finally { conn.release(); }
  }

  private async writeJob(jobId: string, patch: Partial<Job>, expectedStatuses?: Array<Job['status']>): Promise<Job | null> {
    if (['done', 'error', 'rejected'].includes(String(patch.status))) return this.writeTerminalJob(jobId, patch, expectedStatuses);
    const plan = mysqlJobUpdatePlan(patch, new Date().toISOString());
    const whereStatus = expectedStatuses?.length ? ` AND status IN (${expectedStatuses.map(() => '?').join(',')})` : '';
    const [r]: any = await this.pool.query(
      `UPDATE bz_jobs SET ${plan.assignments.join(',')} WHERE job_id=?${whereStatus}`,
      [...plan.values, jobId, ...(expectedStatuses ?? [])],
    );
    if (r?.affectedRows !== 1) return null;
    return this.getJob(jobId);
  }

  async getJob(jobId: string): Promise<Job | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_jobs WHERE job_id=? LIMIT 1', [jobId]);
    const found = (rows as Record<string, unknown>[])[0];
    return found ? rowToJob(found) : null;
  }

  async claimNextJob(targets: string[], executorId: string, leaseMs: number): Promise<Job | null> {
    if (!targets.length) return null;
    return await this.claimQueued(targets, {
      status: 'dispatched',
      owner: executorId,
      setDispatchedAt: true,
      leaseMs,
    });
  }

  async claimNextInhubJob(targets: string[], workerId: string, leaseMs: number): Promise<Job | null> {
    if (!targets.length) return null;
    return await this.claimQueued(targets, {
      status: 'running',
      owner: workerId,
      setDispatchedAt: false,
      leaseMs,
    });
  }

  private async claimQueued(
    targets: string[],
    opts: { status: 'running' | 'dispatched'; owner: string; setDispatchedAt: boolean; leaseMs: number },
  ): Promise<Job | null> {
    const conn = await this.pool.getConnection();
    const token = randomUUID();
    const nowIso = new Date().toISOString();
    const nowS = dt(nowIso);
    const leaseUntilS = dt(new Date(Date.now() + Math.max(1, opts.leaseMs)).toISOString());
    const placeholders = targets.map(() => '?').join(',');
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(
        `SELECT * FROM bz_jobs j
          WHERE j.status='queued'
            AND j.target IN (${placeholders})
            AND (j.run_after IS NULL OR j.run_after <= ?)
            AND (
              j.thread_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM bz_jobs inflight
                WHERE inflight.thread_id=j.thread_id
                  AND inflight.job_id<>j.job_id
                  AND (
                    inflight.status IN ('running','dispatched')
                    OR (
                      inflight.status='queued'
                      AND (inflight.run_after IS NULL OR inflight.run_after <= ?)
                      AND (
                        inflight.created_at < j.created_at
                        OR (inflight.created_at = j.created_at AND inflight.job_id < j.job_id)
                      )
                    )
                  )
              )
            )
          ORDER BY j.created_at ASC, j.job_id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [...targets, nowS, nowS],
      );
      const row = (rows as any[])[0];
      if (!row) {
        await conn.commit();
        return null;
      }
      await conn.query(
        "UPDATE bz_jobs SET status=?, executor_id=?, claimed_at=?, dispatched_at=?, lease_until=?, claim_token=?, run_after=NULL, updated_at=? WHERE job_id=? AND status='queued'",
        [opts.status, opts.owner, nowS, opts.setDispatchedAt ? nowS : null, leaseUntilS, token, nowS, row.job_id],
      );
      const [claimedRows] = await conn.query('SELECT * FROM bz_jobs WHERE job_id=? LIMIT 1', [row.job_id]);
      await conn.commit();
      return (claimedRows as any[])[0] ? rowToJob((claimedRows as any[])[0]) : null;
    } catch (e: any) {
      await conn.rollback().catch(() => undefined);
      if (e?.code === 'ER_PARSE_ERROR' || e?.code === 'ER_NOT_SUPPORTED_YET') {
        return await this.claimQueuedFallback(targets, opts, token, nowS);
      }
      throw e;
    } finally {
      conn.release();
    }
  }

  private async claimQueuedFallback(
    targets: string[],
    opts: { status: 'running' | 'dispatched'; owner: string; setDispatchedAt: boolean; leaseMs: number },
    token: string,
    nowS: string,
  ): Promise<Job | null> {
    const placeholders = targets.map(() => '?').join(',');
    const leaseUntilS = dt(new Date(Date.now() + Math.max(1, opts.leaseMs)).toISOString());
    const [candidates] = await this.pool.query(
      `SELECT * FROM bz_jobs j
        WHERE j.status='queued'
          AND j.target IN (${placeholders})
          AND (j.run_after IS NULL OR j.run_after <= ?)
          AND (
            j.thread_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM bz_jobs inflight
              WHERE inflight.thread_id=j.thread_id
                AND inflight.job_id<>j.job_id
                AND (
                  inflight.status IN ('running','dispatched')
                  OR (
                    inflight.status='queued'
                    AND (inflight.run_after IS NULL OR inflight.run_after <= ?)
                    AND (
                      inflight.created_at < j.created_at
                      OR (inflight.created_at = j.created_at AND inflight.job_id < j.job_id)
                    )
                  )
                )
            )
          )
        ORDER BY j.created_at ASC, j.job_id ASC LIMIT 1`,
      [...targets, nowS, nowS],
    );
    const row = (candidates as any[])[0];
    if (!row) return null;
    const [r]: any = await this.pool.query(
      "UPDATE bz_jobs SET status=?, executor_id=?, claimed_at=?, dispatched_at=?, lease_until=?, claim_token=?, run_after=NULL, updated_at=? WHERE job_id=? AND status='queued'",
      [opts.status, opts.owner, nowS, opts.setDispatchedAt ? nowS : null, leaseUntilS, token, nowS, row.job_id],
    );
    if (!r || r.affectedRows !== 1) return null;
    const [rows] = await this.pool.query('SELECT * FROM bz_jobs WHERE claim_token=? LIMIT 1', [token]);
    return (rows as any[])[0] ? rowToJob((rows as any[])[0]) : null;
  }

  async extendExecutorLeases(executorId: string, leaseMs: number): Promise<number> {
    const nowS = dt(new Date().toISOString());
    const leaseUntilS = dt(new Date(Date.now() + Math.max(1, leaseMs)).toISOString());
    const [r]: any = await this.pool.query(
      "UPDATE bz_jobs SET lease_until=?, updated_at=? WHERE status='dispatched' AND executor_id=?",
      [leaseUntilS, nowS, executorId],
    );
    return r?.affectedRows ?? 0;
  }

  async requeueStaleDispatched(deadAfterMs: number, hardCapMs: number): Promise<number> {
    const nowS = dt(new Date().toISOString());
    const deadCutoff = dt(new Date(Date.now() - deadAfterMs).toISOString());
    const hardCutoff = dt(new Date(Date.now() - hardCapMs).toISOString());
    const [r]: any = await this.pool.query(
      "UPDATE bz_jobs j LEFT JOIN bz_executors e ON e.executor_id=j.executor_id " +
        "SET j.status='queued', j.executor_id=NULL, j.claimed_at=NULL, j.lease_until=NULL, j.dispatched_at=NULL, j.claim_token=NULL, j.updated_at=? " +
        "WHERE j.status='dispatched' AND (" +
        "  (j.lease_until IS NOT NULL AND j.lease_until < ?) " +
        "  OR (j.lease_until IS NULL AND (e.last_seen_at IS NULL OR e.last_seen_at < ?)) " +
        "  OR j.dispatched_at < ?" +
        ")",
      [nowS, nowS, deadCutoff, hardCutoff],
    );
    return r?.affectedRows ?? 0;
  }

  async listJobsByStatus(statuses: Array<Job['status']>, olderThanMs?: number): Promise<Job[]> {
    if (!statuses.length) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const params: unknown[] = [...statuses];
    let sql = `SELECT * FROM bz_jobs WHERE status IN (${placeholders})`;
    if (olderThanMs !== undefined) {
      sql += ' AND updated_at < ?';
      params.push(dt(new Date(Date.now() - olderThanMs).toISOString()));
    }
    sql += ' ORDER BY created_at ASC LIMIT 500';
    const [rows] = await this.pool.query(sql, params);
    return (rows as any[]).map((r) => rowToJob(r));
  }

  async listExpiredLeases(statuses: Array<Job['status']>, fallbackOlderThanMs: number): Promise<Job[]> {
    if (!statuses.length) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const nowS = dt(new Date().toISOString());
    const fallbackCutoff = dt(new Date(Date.now() - fallbackOlderThanMs).toISOString());
    const [rows] = await this.pool.query(
      `SELECT * FROM bz_jobs WHERE status IN (${placeholders})
        AND (
          (lease_until IS NOT NULL AND lease_until < ?)
          OR (lease_until IS NULL AND updated_at < ?)
        )
        ORDER BY created_at ASC LIMIT 500`,
      [...statuses, nowS, fallbackCutoff],
    );
    return (rows as any[]).map((r) => rowToJob(r));
  }

  async expireStaleQueued(ttlMs: number): Promise<number> {
    const cutoff = dt(new Date(Date.now() - ttlMs).toISOString());
    const [rows]: any = await this.pool.query("SELECT job_id FROM bz_jobs WHERE status='queued' AND created_at<? ORDER BY created_at LIMIT 500", [cutoff]);
    let count = 0;
    for (const row of rows) if (await this.updateJobIfStatus(row.job_id, ['queued'], {
      status: 'error', error: '排队超时：执行器长时间不可用，任务已过期（避免恢复后陈旧任务全量重放）',
    })) count++;
    return count;
  }

  async countInflightByThread(threadId: number): Promise<number> {
    const [rows] = await this.pool.query("SELECT COUNT(*) AS n FROM bz_jobs WHERE thread_id=? AND status IN ('queued','running','dispatched')", [threadId]);
    return Number((rows as any[])[0]?.n ?? 0);
  }

  async operationalMetricsSnapshot(nowMs = Date.now()): Promise<JobOperationalMetricsSnapshot> {
    const nowS = dt(new Date(nowMs).toISOString());
    const terminalCutoffS = dt(new Date(nowMs - 15 * 60_000).toISOString());
    const [rows] = await this.pool.query(
      `SELECT
        COALESCE(SUM(j.status='queued'),0) AS queued,
        COALESCE(SUM(j.status='running'),0) AS running,
        COALESCE(SUM(j.status='dispatched'),0) AS dispatched,
        COALESCE(SUM(j.status='done'),0) AS done,
        COALESCE(SUM(j.status='error'),0) AS error,
        COALESCE(SUM(j.status='rejected'),0) AS rejected,
        COALESCE(SUM(j.status='done' AND j.updated_at>=?),0) AS done_15m,
        COALESCE(SUM(j.status='error' AND j.updated_at>=?),0) AS error_15m,
        COALESCE(SUM(j.status='rejected' AND j.updated_at>=?),0) AS rejected_15m,
        MIN(CASE WHEN j.status='queued' AND COALESCE(j.source,'')<>'monitor' THEN j.created_at END) AS oldest_queued_at,
        COALESCE(SUM(j.status='queued' AND j.run_after IS NOT NULL AND j.run_after>?),0) AS delayed_queued,
        COALESCE(SUM(j.status IN ('running','dispatched') AND j.lease_until IS NOT NULL AND j.lease_until<?),0) AS expired_leases,
        (
          SELECT COUNT(DISTINCT q.thread_id)
          FROM bz_jobs q
          JOIN bz_jobs i ON i.thread_id=q.thread_id AND i.status IN ('running','dispatched')
          WHERE q.status='queued' AND q.thread_id IS NOT NULL
        ) AS blocked_threads
      FROM bz_jobs j`,
      [terminalCutoffS, terminalCutoffS, terminalCutoffS, nowS, nowS],
    );
    const row = (rows as any[])[0] ?? {};
    const count = (value: unknown): number => Math.max(Number(value) || 0, 0);
    const oldestQueuedMs = row.oldest_queued_at ? new Date(row.oldest_queued_at).getTime() : Number.NaN;
    return {
      byStatus: {
        queued: count(row.queued),
        running: count(row.running),
        dispatched: count(row.dispatched),
        done: count(row.done),
        error: count(row.error),
        rejected: count(row.rejected),
      },
      terminalLast15m: {
        done: count(row.done_15m),
        error: count(row.error_15m),
        rejected: count(row.rejected_15m),
      },
      oldestQueuedAgeSeconds: Number.isFinite(oldestQueuedMs) ? Math.max((nowMs - oldestQueuedMs) / 1000, 0) : 0,
      delayedQueuedJobs: count(row.delayed_queued),
      expiredLeases: count(row.expired_leases),
      blockedThreads: count(row.blocked_threads),
    };
  }

  async acquireRuntimeLock(lockKey: string, owner: string, ttlMs: number): Promise<boolean> {
    const nowS = dt(new Date().toISOString());
    const expiresS = dt(new Date(Date.now() + Math.max(1, ttlMs)).toISOString());
    const [inserted]: any = await this.pool.query(
      'INSERT IGNORE INTO bz_runtime_locks (lock_key,owner,expires_at,updated_at) VALUES (?,?,?,?)',
      [lockKey, owner, expiresS, nowS],
    );
    if ((inserted?.affectedRows ?? 0) === 1) return true;

    const [updated]: any = await this.pool.query(
      'UPDATE bz_runtime_locks SET owner=?, expires_at=?, updated_at=? WHERE lock_key=? AND (owner=? OR expires_at<=?)',
      [owner, expiresS, nowS, lockKey, owner, nowS],
    );
    if ((updated?.affectedRows ?? 0) === 1) return true;

    // 同一秒内续租可能没有物理变更（affectedRows=0），回读 owner 区分“已持有”与“被别人持有”。
    const [rows] = await this.pool.query('SELECT owner FROM bz_runtime_locks WHERE lock_key=? LIMIT 1', [lockKey]);
    return ((rows as any[])[0]?.owner ?? '') === owner;
  }

  async releaseRuntimeLock(lockKey: string, owner: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_runtime_locks WHERE lock_key=? AND owner=?', [lockKey, owner]);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    const e = completeTraceEntry(entry);
    await this.pool.query(
      'INSERT INTO bz_audit (ts,job_id,request_id,event,stage,severity,title,summary,detail) VALUES (?,?,?,?,?,?,?,?,?)',
      [dt(e.ts), e.job_id, e.request_id, e.event, e.stage, e.severity, e.title, e.summary, json(e.detail)],
    );
  }

  async pruneAuditOlderThan(cutoffIso: string): Promise<number> {
    const [r]: any = await this.pool.query('DELETE FROM bz_audit WHERE ts < ?', [dt(cutoffIso)]);
    return r?.affectedRows ?? 0;
  }
}
