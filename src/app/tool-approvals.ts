import { randomUUID } from 'node:crypto';
import { outboundRuntimeDepsFor, postSignedWithDeps, secretForJobWithDeps } from './outbound';
import type { ApprovalDeps, ApprovalIntentSnap } from '../core/contracts/tools';
import { approvalConfig, type RouteToolsConfig, type ToolSourceConfig } from '../core/config/tools-config';
import type { Job, ToolProvider } from '../core/contracts/types';
import { getTargetDef } from '../core/targets/registry';
import { subjectOf } from './tool-context';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { AppConfig } from '../core/config/config';

/** 重跑时的"已批准调用清单"提示：审批车道 B 的另一半。 */
export async function approvedNoteForJobFor(config: ConfigStoreContract | null, jobId: string): Promise<string | undefined> {
  if (!config) return undefined;
  const rows = await config.approvals.approvedUnusedForJob(jobId).catch(() => []);
  if (!rows.length) return undefined;
  return [
    '【已批准操作】以下工具调用已获人工批准，请直接按原样执行（工具名与参数均不得更改，任何改动会再次触发审批）：',
    ...rows.map((a) => `- ${a.tool} 参数 ${a.args_json ?? '{}'}（审批单 ${a.id}）`),
  ].join('\n');
}

/** 审批车道句柄：bz_tool_approvals 读写 + 送达插座推审批人。 */
export function approvalDepsForStores(
  config: ConfigStoreContract | null,
  state: RuntimeStateStore,
  job: Job,
  provider: ToolProvider,
  toolsCfg: RouteToolsConfig,
  sourceCfg: ToolSourceConfig,
  appConfig: AppConfig,
  nowFn: () => string,
  sleepFn: (ms: number) => Promise<void>,
): ApprovalDeps | undefined {
  if (!config) return undefined;
  const cs = config;
  return {
    async consumeApproved(tool, hash) {
      const a = await cs.approvals.find(job.job_id, tool, hash, 'approved', true);
      if (!a) return null;
      return (await cs.approvals.use(a.id)) ? a.id : null;
    },
    async findApprovedAnyArgs(tool) {
      const rows = await cs.approvals.approvedUnusedForJob(job.job_id).catch(() => []);
      const a = rows.find((r) => r.tool === tool);
      return a ? { id: a.id, args_json: a.args_json ?? '{}' } : null;
    },
    async findPending(tool, hash) {
      const a = await cs.approvals.find(job.job_id, tool, hash, 'pending');
      return a ? a.id : null;
    },
    async create(snap) {
      const onBehalfOf = subjectOf(job, sourceCfg);
      const intent = approvalIntentFor(job, provider, sourceCfg, snap, onBehalfOf);
      return await cs.approvals.create({
        job_id: job.job_id, request_id: job.request_id, provider: provider.name,
        tool: snap.tool, scope: snap.scope, risk: snap.risk, policy: snap.policy, reason: snap.reason,
        method: snap.method, path: snap.path, summary: snap.summary,
        args_json: snap.args_json, args_hash: snap.args_hash, intent, on_behalf_of: onBehalfOf || undefined,
      });
    },
    async notify(id, snap) {
      await notifyApprovalFor(config, state, job, provider, toolsCfg, sourceCfg, id, snap, appConfig, nowFn, sleepFn);
    },
  };
}

function approvalIntentFor(job: Job, provider: ToolProvider, sourceCfg: ToolSourceConfig, snap: ApprovalIntentSnap, subject: string): Record<string, unknown> {
  let args: unknown = {};
  try { args = JSON.parse(snap.args_json || '{}'); } catch { args = snap.args_json; }
  return {
    kind: 'tool_approval_intent',
    schema_version: 'bailing.approval-intent.v1',
    job_id: job.job_id,
    request_id: job.request_id,
    route_key: job.dispatch?.route_key,
    route_name: job.dispatch?.route_name,
    source: job.source,
    subject: subject || undefined,
    subject_field: sourceCfg.subject_field || undefined,
    provider: provider.name,
    tool: snap.tool,
    scope: snap.scope,
    risk: snap.risk,
    policy: snap.policy,
    reason: snap.reason,
    method: snap.method,
    path: snap.path,
    args,
    args_hash: snap.args_hash,
    summary: snap.summary,
    confirm_when: snap.confirm_when,
    metadata: job.metadata ?? {},
  };
}

async function notifyApprovalFor(
  config: ConfigStoreContract | null,
  state: RuntimeStateStore,
  job: Job,
  provider: ToolProvider,
  toolsCfg: RouteToolsConfig,
  sourceCfg: ToolSourceConfig,
  approvalId: number,
  snap: ApprovalIntentSnap,
  appConfig: AppConfig,
  nowFn: () => string,
  sleepFn: (ms: number) => Promise<void>,
): Promise<void> {
  const outboundRuntime = outboundRuntimeDepsFor({
    cfg: appConfig,
    configStore: config,
    stateStore: state,
    now: nowFn,
    sleep: sleepFn,
  });
  const subject = subjectOf(job, sourceCfg);
  const intent = approvalIntentFor(job, provider, sourceCfg, snap, subject);
  const content = [
    `【${appConfig.brand.name}】工具调用待审批`,
    `审批单：${approvalId}`,
    ...(snap.summary ? [`动作：${snap.summary}`] : []),
    `触发原因：${snap.reason}`,
    `任务：${job.dispatch?.route_name || job.request_id}（job ${job.job_id}）`,
    `工具：${snap.tool}（scope ${snap.scope}，风险 ${snap.risk}）`,
    `参数：${snap.args_json}`,
    '请到控制台「工具审批」页处理；批准后任务将自动重跑完成该操作。',
    '', `—— ${appConfig.brand.name}`,
  ].join('\n');
  const ap = approvalConfig(toolsCfg)
    ?? (appConfig.alerts ? { type: appConfig.alerts.type, url: appConfig.alerts.url, to: appConfig.alerts.to } : undefined);
  if (!ap || !ap['type']) {
    await state.appendAudit({ ts: nowFn(), job_id: job.job_id, request_id: job.request_id, event: 'approval_notify_skipped', detail: { approval_id: approvalId, reason: '未配置审批通知渠道（路由 tools.approval 与 config alerts 均空），请在控制台「工具审批」处理' } });
    return;
  }
  const type = String(ap['type']);
  if ((type === 'business_webhook' || type === 'approval_webhook') && ap['url']) {
    let args: unknown = {};
    try { args = JSON.parse(snap.args_json || '{}'); } catch { args = snap.args_json; }
    void postSignedWithDeps(outboundRuntime, String(ap['url']), {
      kind: 'tool_approval_request',
      approval_id: approvalId,
      job_id: job.job_id,
      request_id: job.request_id,
      route: job.dispatch?.route_name,
      subject: subjectOf(job, sourceCfg) || undefined,
      provider: provider.name,
      tool: snap.tool,
      scope: snap.scope,
      risk: snap.risk,
      policy: snap.policy,
      reason: snap.reason,
      method: snap.method,
      path: snap.path,
      args,
      args_hash: snap.args_hash,
      summary: snap.summary,
      intent: { approval_id: approvalId, ...intent },
      decision_path: `/approvals/${approvalId}/decision`,
      decision_contract: {
        kind: 'tool_approval_decision',
        schema_version: 'bailing.approval-decision.v1',
        required_fields: ['approval_id', 'job_id', 'request_id', 'args_hash', 'decision_id', 'decision', 'approver'],
        decision_values: ['approved', 'denied'],
        idempotency: 'decision_id',
        match: {
          approval_id: approvalId,
          job_id: job.job_id,
          request_id: job.request_id,
          args_hash: snap.args_hash,
        },
        example: {
          kind: 'tool_approval_decision',
          schema_version: 'bailing.approval-decision.v1',
          approval_id: approvalId,
          job_id: job.job_id,
          request_id: job.request_id,
          args_hash: snap.args_hash,
          decision_id: `biz-${approvalId}-<your-approval-record-id>`,
          decision: 'approved',
          approver: '<business-user-id>',
          comment: '',
        },
      },
      metadata: job.metadata ?? {},
    }, await secretForJobWithDeps(outboundRuntime, job), { job_id: job.job_id, request_id: job.request_id, event: 'approval_intent_webhook' });
    return;
  }
  if (type === 'webhook' && ap['url']) {
    void postSignedWithDeps(outboundRuntime, String(ap['url']), {
      kind: 'tool_approval', approval_id: approvalId, job_id: job.job_id, request_id: job.request_id,
      tool: snap.tool, scope: snap.scope, risk: snap.risk, policy: snap.policy, reason: snap.reason, args: snap.args_json, intent: { approval_id: approvalId, ...intent }, message: content,
    }, await secretForJobWithDeps(outboundRuntime, job), { job_id: job.job_id, request_id: job.request_id, event: 'approval_notify' });
    return;
  }
  const targetName = `${type}-notify`;
  if (getTargetDef(targetName)?.kind !== 'executor' || !ap['to']) {
    await state.appendAudit({ ts: nowFn(), job_id: job.job_id, request_id: job.request_id, event: 'approval_notify_skipped', detail: { approval_id: approvalId, reason: `送达类型 ${type} 不可用（需注册 ${targetName} 执行器目标且配收件人）` } });
    return;
  }
  const reqId = `approval_${approvalId}`;
  if (await state.findByRequestId(reqId)) return;
  const child: Job = {
    job_id: randomUUID(), request_id: reqId, status: 'queued',
    target: targetName, profile: 'delivery', project: '', source: 'delivery',
    session_id: randomUUID(), input_preview: content.slice(0, 200), input: content,
    dispatch: { target_config: ap }, metadata: { to: String(ap['to']), approval_id: approvalId, parent_job_id: job.job_id },
    created_at: nowFn(), updated_at: nowFn(),
  };
  await state.createJob(child);
  await state.appendAudit({ ts: nowFn(), job_id: job.job_id, request_id: job.request_id, event: 'approval_notify_queued', detail: { approval_id: approvalId, type, to: ap['to'], child_job: child.job_id } });
}
