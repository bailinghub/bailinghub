// 收尾运行时：任务终态落库后，统一处理 finished 审计、出站总账、callback、delivery 与送达失败告警。
// 不依赖 runtime 单例；engine 只注入收尾所需的状态仓库、会话账本、送达死信账本与出站能力。
import type { AuditEntry } from '../contracts/types';
import type { Job } from '../contracts/types';

export interface FinishStateStoreLike {
  updateJob(jobId: string, patch: Partial<Job>): Promise<Job | null>;
  appendAudit(entry: AuditEntry): Promise<void>;
}

export interface FinishConversationLedgerLike {
  appendMessage(m: { thread_id: number; direction: 'in' | 'out'; channel: string; principal_id?: string | null; job_id?: string | null; content: string }): Promise<void>;
}

export interface FinishDeliveryDlqLike {
  record(d: { parentJobId: string; channel: string; recipient: string; content: string; error: string }): Promise<void>;
}

export interface FinishRuntimeDeps {
  store: FinishStateStoreLike;
  conversationLedger?: FinishConversationLedgerLike | null;
  deliveryDlq?: FinishDeliveryDlqLike | null;
  now: () => string;
  fireCallback: (url: string, job: Job) => Promise<void>;
  spawnDeliveryJob: (job: Job) => Promise<void>;
  sendAlert: (key: string, text: string) => Promise<void>;
  summarizeThread?: (job: Job) => Promise<void>;
}

export function resultLedgerContent(job: Job): string {
  const r = (job.result ?? {}) as Record<string, unknown>;
  return typeof r['text'] === 'string' && r['text']
    ? (r['text'] as string)
    : r['report'] ? JSON.stringify(r['report']) : (job.raw_result ?? '');
}

export function deliveryFailureRecipient(job: Job): string {
  return String((job.metadata ?? {})['recipient'] ?? (job.metadata ?? {})['to'] ?? '?');
}

export async function finishJob(job: Job, patch: Partial<Job>, deps: FinishRuntimeDeps): Promise<Job | null> {
  const terminal = patch.status === 'done' || patch.status === 'error' || patch.status === 'rejected';
  const finalPatch: Partial<Job> = terminal
    ? { ...patch, executor_id: undefined, claimed_at: undefined, lease_until: undefined, dispatched_at: undefined, claim_token: undefined }
    : patch;
  const updated = await deps.store.updateJob(job.job_id, finalPatch);
  await deps.store.appendAudit({
    ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event: 'finished',
    detail: { status: patch.status, cost_usd: updated?.usage?.cost_usd ?? 0 },
  });

  const threadId = updated?.thread_id ?? job.thread_id;
  // 总账记出站（done 才记；失败不阻塞）。必须 await 后再交棒，保证同会话下一条装配能看到本条回复。
  if (updated && updated.status === 'done' && threadId && deps.conversationLedger) {
    const content = resultLedgerContent(updated);
    if (content) {
      try { await deps.conversationLedger.appendMessage({ thread_id: threadId, direction: 'out', channel: 'hub', job_id: job.job_id, content }); }
      catch { /* 总账故障可降级：丢的是连续性不是任务 */ }
      void deps.summarizeThread?.(job).catch(() => { /* 摘要失败不阻塞 */ });
    }
  }

  if (updated && job.callback_url) void deps.fireCallback(job.callback_url, updated);

  // 送达层：done 或 error 都进（spawnDeliveryJob 内裁决：失败只回调 webhook 不推人渠道）。
  if (updated && (updated.status === 'done' || updated.status === 'error')) {
    void deps.spawnDeliveryJob(updated).catch(async (e) => {
      await deps.store.appendAudit({ ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event: 'delivery_error', detail: { error: String(e) } });
    });
  }

  // 送达子任务（executor-notify 渠道）重试耗尽 → 终态 error：必须告警 + 落 DLQ。
  if (updated && updated.status === 'error' && (job.source === 'delivery' || (job.target ?? '').endsWith('-notify'))) {
    const to = deliveryFailureRecipient(job);
    const err = String(patch.error ?? updated.error ?? '未知错误').slice(0, 200);
    void deps.sendAlert(`delivery_failed_${job.target}`,
      `送达任务最终失败（渠道 ${job.target}，收件人 ${to}）：${err}。收件人可能未收到结果，请到控制台「任务」查 ${job.job_id} 并手动补发。`)
      .catch(() => { /* 告警失败不影响主流程 */ });
    void deps.deliveryDlq?.record({ parentJobId: job.job_id, channel: String(job.target ?? ''), recipient: to, content: job.input ?? '', error: err }).catch(() => undefined);
  }

  return updated;
}
