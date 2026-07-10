// 业务侧审批决策回调：生产形态下，高风险工具调用的审批权在业务系统/OA/IM 流程里。
// 中枢只验证这次决策可信、更新闸门账本，并在批准后重跑原任务消费精确快照。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, readRawBody, send } from '../app/http';
import { presentedToken } from '../app/auth';
import type { EngineRuntime } from '../app/engine';
import { verifySignedBody as verifyWebhookSignature } from '../core/platform/signing';
import type { Client, Job } from '../core/contracts/types';
import { parseApprovalDecisionEnvelope } from '../core/contracts/approval-decision';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export interface ApprovalDecisionDeps {
  cfg: AppConfig;
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  secretForJob: (job: Job) => Promise<string>;
  engineRuntime: Pick<EngineRuntime, 'requeueForRerun'>;
}

async function clientOwnsJob(configStore: ConfigStoreContract | null, client: Client, job: Job): Promise<boolean> {
  if (job.client_app_id && job.client_app_id === client.app_id) return true;
  const entryKey = String((job.metadata ?? {})['chat_entry'] ?? '');
  if (!entryKey || !configStore) return false;
  const entry = await configStore.chatEntries.get(entryKey).catch(() => null);
  return entry?.ticket_client === client.app_id;
}

async function verifyBearer(deps: ApprovalDecisionDeps, req: IncomingMessage, url: URL, job: Job): Promise<string | null> {
  const token = presentedToken(req, url);
  if (!token) return null;
  if (deps.cfg.server.token && token === deps.cfg.server.token) return 'admin-token';
  if (!deps.configStore) return null;
  const client = await deps.configStore.clients.getByToken(token).catch(() => null);
  if (client && client.enabled && await clientOwnsJob(deps.configStore, client, job)) return `client:${client.app_id}`;
  return null;
}

async function verifySignedApprovalBody(deps: ApprovalDecisionDeps, req: IncomingMessage, job: Job, raw: string): Promise<string | null> {
  return verifyWebhookSignature(req.headers, await deps.secretForJob(job), raw) ? 'signed-business' : null;
}

export async function handleApprovalDecisionFor(deps: ApprovalDecisionDeps, req: IncomingMessage, res: ServerResponse, approvalId: number, url: URL): Promise<void> {
  if (!deps.configStore) { send(res, 400, { error: '审批回调需要 mysql 配置后台' }); return; }
  const approval = await deps.configStore.approvals.get(approvalId);
  if (!approval) { send(res, 404, { error: '审批单不存在' }); return; }
  const job = await deps.stateStore.getJob(approval.job_id);
  if (!job) { send(res, 404, { error: '审批单关联任务不存在' }); return; }

  let raw = '';
  let body: Record<string, unknown> = {};
  try {
    raw = await readRawBody(req, 64 * 1024);
    body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch (e) {
    send(res, 400, { error: `请求体不是合法 JSON：${errMsg(e)}` }); return;
  }

  const byAuth = await verifyBearer(deps, req, url, job) ?? await verifySignedApprovalBody(deps, req, job, raw);
  if (!byAuth) { send(res, 401, { error: '审批决策验签失败或 token 无权裁决该任务' }); return; }

  const parsed = parseApprovalDecisionEnvelope(body, {
    id: approval.id,
    job_id: approval.job_id,
    request_id: approval.request_id,
    args_hash: approval.args_hash,
  });
  if (!parsed.ok) { send(res, 400, { error: parsed.error }); return; }
  const decision = parsed.value;

  const sameDecision = approval.status === decision.decision && approval.decision_id === decision.decision_id;
  if (approval.status !== 'pending') {
    if (sameDecision) {
      send(res, 200, { ok: true, id: approvalId, status: approval.status, decision_id: decision.decision_id, idempotent: true, rerun: false });
      return;
    }
    send(res, 409, { error: `审批单已是 ${approval.status}，不可重复裁决`, status: approval.status, decision_id: approval.decision_id }); return;
  }

  const existingDecision = await deps.configStore.approvals.getByDecisionId(decision.decision_id);
  if (existingDecision && existingDecision.id !== approvalId) {
    send(res, 409, { error: 'decision_id 已用于其他审批单', decision_id: decision.decision_id, approval_id: existingDecision.id }); return;
  }

  if (!await deps.configStore.approvals.decide(approvalId, decision.decision, decision.approver, { decision_id: decision.decision_id, comment: decision.comment })) {
    send(res, 409, { error: '审批单状态已变化，请刷新后重试' }); return;
  }

  await deps.stateStore.appendAudit({
    ts: deps.now(),
    job_id: approval.job_id,
    request_id: approval.request_id,
    event: decision.decision === 'approved' ? 'tool_approved_external' : 'tool_denied_external',
    detail: {
      approval_id: approvalId,
      decision_id: decision.decision_id,
      tool: approval.tool,
      scope: approval.scope,
      by: decision.approver,
      auth: byAuth,
      policy: approval.policy,
      reason: approval.reason,
      summary: approval.summary,
      ...(decision.comment ? { comment: decision.comment } : {}),
    },
  });

  let rerun = false;
  if (decision.decision === 'approved') {
    const latest = await deps.stateStore.getJob(approval.job_id);
    if (latest && (latest.status === 'done' || latest.status === 'error' || latest.status === 'rejected')) {
      await deps.engineRuntime.requeueForRerun(latest, decision.approver, `approval_${approvalId}`);
      rerun = true;
    }
  }
  send(res, 200, { ok: true, id: approvalId, status: decision.decision, decision_id: decision.decision_id, idempotent: false, rerun });
}
