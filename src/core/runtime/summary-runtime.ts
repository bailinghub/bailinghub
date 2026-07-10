// 滚动摘要运行时：任务完成后把较早对话增量压缩进 thread.summary。
// 不依赖 runtime 单例；engine 负责注入 store、凭证解析与 LLM 调用。实例内先去重，生产可叠加运行期短租约锁做跨实例去重。
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config';
import type { CredentialStoreLike } from './credential-resolver';
import type { ResolvedCredentialRef } from './credential-resolver';
import { buildSummaryMessages, resolveMemoryConfig, type MemoryConfig, type MsgLite } from './memory';
import type { AuditEntry, Job } from '../contracts/types';

export interface SummaryThreadMemory {
  summary: string | null;
  summary_upto_id: number;
}

export interface SummaryMessage extends MsgLite {
  id: number;
}

export interface SummaryStoreLike {
  getThreadMemory(threadId: number): Promise<SummaryThreadMemory>;
  unsummarizedMessages(threadId: number, afterId: number, limit?: number): Promise<SummaryMessage[]>;
  writeThreadSummary(threadId: number, summary: string, newWatermark: number, expectedWatermark: number): Promise<boolean>;
}

export interface SummaryAuditStoreLike {
  appendAudit(entry: AuditEntry): Promise<void>;
}

export interface SummaryLockStoreLike {
  acquireRuntimeLock(lockKey: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseRuntimeLock(lockKey: string, owner: string): Promise<void>;
}

export interface SummaryRuntimeDeps {
  cfg: Pick<AppConfig, 'llmCredentials'>;
  summaryStore?: SummaryStoreLike | null;
  credentialStore?: CredentialStoreLike | null;
  auditStore: SummaryAuditStoreLike;
  lockStore?: SummaryLockStoreLike | null;
  lockOwner?: string;
  lockTtlMs?: number;
  now: () => string;
  resolveSummaryCredential: (targetConfig: unknown, cfg: Pick<AppConfig, 'llmCredentials'>, store?: CredentialStoreLike | null) => Promise<ResolvedCredentialRef | null>;
  callLlmText: (cred: { base_url: string; api_key: string }, model: string, system: string, user: string) => Promise<{ text: string; tokens: number }>;
}

export interface SummaryRuntime {
  maybeSummarizeThread(job: Job): Promise<void>;
}

function memoryConfigFromJob(job: Job): MemoryConfig | null {
  const memRaw = job.dispatch?.memory as Record<string, unknown> | undefined;
  if (!memRaw) return null;
  const memCfg = resolveMemoryConfig(memRaw);
  return memCfg.summary_enabled ? memCfg : null;
}

export function shouldSummarizeTail(tail: SummaryMessage[], cfg: MemoryConfig): boolean {
  if (tail.length <= cfg.summary_keep_recent) return false;
  const tailChars = tail.reduce((a, m) => a + m.content.length, 0);
  return tailChars >= cfg.summary_trigger_chars;
}

export function evictForSummary(tail: SummaryMessage[], cfg: MemoryConfig): SummaryMessage[] {
  return tail.slice(0, Math.max(0, tail.length - cfg.summary_keep_recent));
}

export function clampSummaryText(text: string, cfg: MemoryConfig): string {
  return text.length > cfg.summary_max_chars * 2 ? text.slice(0, cfg.summary_max_chars * 2) : text;
}

export function createSummaryRuntime(deps: SummaryRuntimeDeps): SummaryRuntime {
  const summarizingThreads = new Set<number>();
  const lockOwner = deps.lockOwner ?? `summary:${process.pid}:${randomUUID()}`;
  const lockTtlMs = Math.max(1, deps.lockTtlMs ?? 120_000);

  async function audit(job: Job, event: string, detail: Record<string, unknown>): Promise<void> {
    await deps.auditStore.appendAudit({ ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event, detail }).catch(() => undefined);
  }

  async function withSummaryLock(threadId: number, task: () => Promise<void>): Promise<void> {
    const lockStore = deps.lockStore;
    if (!lockStore) {
      await task();
      return;
    }
    const lockKey = `summary:${threadId}`;
    if (!(await lockStore.acquireRuntimeLock(lockKey, lockOwner, lockTtlMs))) return;
    const renewEveryMs = Math.max(1_000, Math.floor(lockTtlMs / 3));
    const renewTimer = setInterval(() => {
      void lockStore.acquireRuntimeLock(lockKey, lockOwner, lockTtlMs).catch(() => undefined);
    }, renewEveryMs);
    renewTimer.unref?.();
    try {
      await task();
    } finally {
      clearInterval(renewTimer);
      await lockStore.releaseRuntimeLock(lockKey, lockOwner).catch(() => undefined);
    }
  }

  return {
    async maybeSummarizeThread(job: Job): Promise<void> {
      if (!deps.summaryStore || !job.thread_id) return;
      const memCfg = memoryConfigFromJob(job);
      if (!memCfg) return;
      const threadId = job.thread_id;
      if (summarizingThreads.has(threadId)) return;
      summarizingThreads.add(threadId);
      try {
        await withSummaryLock(threadId, async () => {
          const tm = await deps.summaryStore!.getThreadMemory(threadId);
          const tail = await deps.summaryStore!.unsummarizedMessages(threadId, tm.summary_upto_id);
          if (!shouldSummarizeTail(tail, memCfg)) return;
          const evict = evictForSummary(tail, memCfg);
          if (!evict.length) return;
          const newWatermark = evict[evict.length - 1]!.id;
          const credRef = await deps.resolveSummaryCredential(job.dispatch?.target_config, deps.cfg, deps.credentialStore);
          if (!credRef) {
            await audit(job, 'memory_summary_skipped', { thread_id: threadId, reason: 'no_credential' });
            return;
          }
          const cred = credRef.credential;
          const model = memCfg.summary_model || cred.default_model || '';
          if (!model) {
            await audit(job, 'memory_summary_skipped', { thread_id: threadId, reason: 'no_model' });
            return;
          }
          const t0 = Date.now();
          const { system, user } = buildSummaryMessages(tm.summary, evict, memCfg);
          const { text, tokens } = await deps.callLlmText({ base_url: cred.base_url, api_key: cred.api_key }, model, system, user);
          const summary = clampSummaryText(text, memCfg);
          const ok = await deps.summaryStore!.writeThreadSummary(threadId, summary, newWatermark, tm.summary_upto_id);
          await audit(job, ok ? 'memory_summarized' : 'memory_summary_raced', {
            thread_id: threadId,
            from_id: tm.summary_upto_id,
            to_id: newWatermark,
            evicted: evict.length,
            kept: memCfg.summary_keep_recent,
            summary_len: summary.length,
            model,
            tokens,
            duration_ms: Date.now() - t0,
          });
        });
      } catch (e) {
        await audit(job, 'memory_summary_error', { thread_id: threadId, error: String(e).slice(0, 200) });
      } finally {
        summarizingThreads.delete(threadId);
      }
    },
  };
}
