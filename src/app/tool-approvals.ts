import { randomUUID } from 'node:crypto';
import { outboundRuntimeDepsFor, postSignedWithDeps, postSignedNotificationWithDeps, secretForJobWithDeps, type NotificationSendOutcome } from './outbound';
import type { ApprovalDeps, ApprovalIntentSnap } from '../core/contracts/tools';
import { approvalNotificationSnapshot } from '../core/contracts/tools';
import { approvalConfig, type RouteToolsConfig, type ToolSourceConfig, type ToolApprovalConfig } from '../core/config/tools-config';
import type { Job, ToolProvider } from '../core/contracts/types';
import { defaultTargetRegistry, type TargetRegistry } from '../core/targets/registry';
import { subjectOf } from './tool-context';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { AppConfig } from '../core/config/config';
import { isAgentToolInvocationJob } from './agent-tool-job';
import { notificationBackgroundWorkFor } from '../core/runtime/notification-background-work';
import { wakeNotificationOutboxFor } from '../core/runtime/notification-outbox-work';
import type { ApprovalNotificationPayload } from '../core/contracts/notification-outbox';
import { createNotificationChildOnce } from './delivery';

/** Private encrypted recovery material is not approval intent or notification metadata. */
function approvalVisibleJob(job: Job): Job {
  const metadata = { ...job.metadata };
  delete metadata.agent_frozen_arguments;
  return { ...job, metadata };
}

function notificationDestination(tools: RouteToolsConfig, config: AppConfig): ToolApprovalConfig | undefined {
  const value = approvalConfig(tools) ?? config.alerts;
  if (!value?.type) return undefined;
  // Freeze routing coordinates only; provider/channel credentials stay in their own stores.
  return { type: value.type, ...(value.url ? { url: value.url } : {}), ...(value.to ? { to: value.to } : {}) };
}

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
  targetRegistry: TargetRegistry = defaultTargetRegistry,
): ApprovalDeps | undefined {
  if (!config) return undefined;
  const cs = config;
  return {
    continuationMode: isAgentToolInvocationJob(job) ? 'resume' : 'rerun',
    async consumeApproved(tool, hash) {
      const a = await cs.approvals.find(job.job_id, tool, hash, 'approved', true);
      if (!a) return null;
      return (await cs.approvals.use(a.id)) ? a.id : null;
    },
    async peekApproved(tool, hash) {
      const a = await cs.approvals.find(job.job_id, tool, hash, 'approved');
      return a?.id ?? null;
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
      const approval = {
        job_id: job.job_id, request_id: job.request_id, provider: provider.name,
        tool: snap.tool, scope: snap.scope, risk: snap.risk, policy: snap.policy, reason: snap.reason,
        method: snap.method, path: snap.path, summary: snap.summary,
        args_json: snap.args_json, args_hash: snap.args_hash, intent, on_behalf_of: onBehalfOf || undefined,
      };
      if (cs.approvals.createWithNotification) {
        const id = await cs.approvals.createWithNotification(approval, {
          job: approvalVisibleJob(job), provider_name: provider.name, subject: onBehalfOf, subject_field: sourceCfg.subject_field,
          snap: approvalNotificationSnapshot(snap), brand_name: appConfig.brand.name,
          destination: notificationDestination(toolsCfg, appConfig),
        });
        wakeNotificationOutboxFor(state);
        return id;
      }
      return cs.approvals.create(approval);
    },
    async notify(id, snap) {
      if (cs.approvals.createWithNotification) { wakeNotificationOutboxFor(state); return; }
      // Compatibility for external ledgers without the durable creation port.
      await notificationBackgroundWorkFor(state).track('approval-notification', async () => {
        await notifyApprovalPayloadFor(config, state, { approval_id: id, job, provider_name: provider.name,
          subject: subjectOf(job, sourceCfg), subject_field: sourceCfg.subject_field, snap: approvalNotificationSnapshot(snap), brand_name: appConfig.brand.name,
          destination: notificationDestination(toolsCfg, appConfig),
        }, appConfig, nowFn, sleepFn, targetRegistry);
      });
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
    ...(snap.args_bytes !== undefined ? { args_bytes: snap.args_bytes } : {}),
    ...(snap.args_truncated ? { args_truncated: true } : {}),
    summary: snap.summary,
    confirm_when: snap.confirm_when,
    metadata: approvalVisibleJob(job).metadata,
  };
}

export async function notifyApprovalPayloadFor(
  config: ConfigStoreContract | null,
  state: RuntimeStateStore,
  payload: ApprovalNotificationPayload,
  appConfig: AppConfig,
  nowFn: () => string,
  sleepFn: (ms: number) => Promise<void>,
  targetRegistry: TargetRegistry,
  eventId?: string,
): Promise<NotificationSendOutcome> {
  const { approval_id: approvalId } = payload;
  // Also bound historical durable drafts before sending; new producers already store this view.
  const job = approvalVisibleJob(payload.job);
  const snap = approvalNotificationSnapshot(payload.snap);
  const provider = { name: payload.provider_name } as ToolProvider;
  const sourceCfg = { provider: payload.provider_name, allow: [], subject_field: payload.subject_field };
  const subject = payload.subject;
  const brandName = payload.brand_name ?? appConfig.brand.name;
  if (eventId) {
    if (!config) return { status: 'failed', error: 'Approval repository unavailable' };
    const approval = await config.approvals.get(approvalId);
    if (!approval || approval.job_id !== job.job_id || approval.request_id !== job.request_id) return { status: 'failed', error: 'approval_notification_binding_conflict' };
    if (approval.status !== 'pending') return { status: 'skipped', error: 'Approval already decided' };
  }
  const outboundRuntime = outboundRuntimeDepsFor({
    cfg: appConfig,
    configStore: config,
    stateStore: state,
    now: nowFn,
    sleep: sleepFn,
  });
  const intent = approvalIntentFor(job, provider, sourceCfg, snap, subject);
  const content = [
    `【${brandName}】工具调用待审批`,
    `审批单：${approvalId}`,
    ...(snap.summary ? [`动作：${snap.summary}`] : []),
    `触发原因：${snap.reason}`,
    `任务：${job.dispatch?.route_name || job.request_id}（job ${job.job_id}）`,
    `工具：${snap.tool}（scope ${snap.scope}，风险 ${snap.risk}）`,
    `${snap.args_truncated ? '参数预览（已截断，完整参数请到授权控制台查看）' : '参数'}：${snap.args_json}`,
    isAgentToolInvocationJob(job)
      ? '请到控制台「工具审批」页处理；批准后由原本地 Agent 用 invocation_id 续执行，中枢不启动模型重跑。'
      : '请到控制台「工具审批」页处理；批准后任务将自动重跑完成该操作。',
    '', `—— ${brandName}`,
  ].join('\n');
  const ap = payload.destination;
  const post = async (url: string, body: Record<string, unknown>, event: string): Promise<NotificationSendOutcome> => {
    const secret = await secretForJobWithDeps(outboundRuntime, job);
    const audit = { job_id: job.job_id, request_id: job.request_id, event };
    if (eventId) return postSignedNotificationWithDeps(outboundRuntime, url, body, secret, eventId, audit);
    void postSignedWithDeps(outboundRuntime, url, body, secret, audit);
    return { status: 'completed' };
  };
  if (!ap || !ap['type']) {
    await state.appendAudit({ ts: nowFn(), job_id: job.job_id, request_id: job.request_id, event: 'approval_notify_skipped', detail: { approval_id: approvalId, reason: '未配置审批通知渠道（路由 tools.approval 与 config alerts 均空），请在控制台「工具审批」处理' } });
    return { status: 'skipped', error: 'Approval destination not configured' };
  }
  const type = String(ap['type']);
  if ((type === 'business_webhook' || type === 'approval_webhook') && ap['url']) {
    let args: unknown = {};
    try { args = JSON.parse(snap.args_json || '{}'); } catch { args = snap.args_json; }
    return post(String(ap['url']), {
      kind: 'tool_approval_request',
      approval_id: approvalId,
      job_id: job.job_id,
      request_id: job.request_id,
      route: job.dispatch?.route_name,
      subject: subject || undefined,
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
      ...(snap.args_bytes !== undefined ? { args_bytes: snap.args_bytes } : {}),
      ...(snap.args_truncated ? { args_truncated: true } : {}),
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
    }, 'approval_intent_webhook');
  }
  if (type === 'webhook' && ap['url']) {
    return post(String(ap['url']), {
      kind: 'tool_approval', approval_id: approvalId, job_id: job.job_id, request_id: job.request_id,
      tool: snap.tool, scope: snap.scope, risk: snap.risk, policy: snap.policy, reason: snap.reason, args: snap.args_json,
      ...(snap.args_bytes !== undefined ? { args_bytes: snap.args_bytes } : {}),
      ...(snap.args_truncated ? { args_truncated: true } : {}),
      intent: { approval_id: approvalId, ...intent }, message: content,
    }, 'approval_notify');
  }
  const targetName = `${type}-notify`;
  if (targetRegistry.get(targetName)?.kind !== 'executor' || !ap['to']) {
    await state.appendAudit({ ts: nowFn(), job_id: job.job_id, request_id: job.request_id, event: 'approval_notify_skipped', detail: { approval_id: approvalId, reason: `送达类型 ${type} 不可用（需注册 ${targetName} 执行器目标且配收件人）` } });
    return { status: 'skipped', error: 'Approval notification executor or recipient unavailable' };
  }
  const reqId = `approval_${approvalId}`;
  const child: Job = {
    job_id: randomUUID(), request_id: reqId, status: 'queued',
    target: targetName, profile: 'delivery', project: '', source: 'delivery',
    session_id: randomUUID(), input_preview: content.slice(0, 200), input: content,
    dispatch: { target_config: ap }, metadata: { to: String(ap['to']), approval_id: approvalId, parent_job_id: job.job_id, ...(eventId ? { notification_event_id: eventId } : {}) },
    created_at: nowFn(), updated_at: nowFn(),
  };
  await createNotificationChildOnce(state, child);
  await state.appendAudit({ ts: nowFn(), job_id: job.job_id, request_id: job.request_id, event: 'approval_notify_queued', detail: { approval_id: approvalId, type, to: ap['to'], child_job: child.job_id } }).catch(() => undefined);
  return { status: 'completed' };
}
