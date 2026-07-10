import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, readBody, send } from './http';
import { TOOL_INLINE_MAX, type ToolRuntime } from '../core/contracts/tools';
import type { ToolDefinition } from '../core/contracts/tool-definition';
import { toolSummary } from '../core/contracts/tool-definition';
import { SEND_MAX_CALLS, SEND_TOOL_NAME, resolveSendChannelsFor, runSendMessageFor, sendToolDef } from './builtin-tools';
import type { Job } from '../core/contracts/types';
import { approvedNoteForJobFor } from './tool-approvals';
import { assembleToolRuntimeFor } from './tool-assembly';
import { maxCallsOf, resolveAllowedToolsFor } from './tool-context';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { ToolIndexService } from '../services/tools-index';

export interface ToolProxyDeps {
  cfg: AppConfig;
  configStore: ConfigStoreContract | null;
  stateStore: RuntimeStateStore;
  toolIndex: ToolIndexService | null;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
}

/** 任务级工具凭证：HMAC(server.token, job_id.claim_token)。 */
function toolTokenFor(jobId: string, claimToken: string, serverToken: string): string {
  return createHmac('sha256', serverToken || 'bailing').update(`${jobId}.${claimToken}`).digest('hex');
}

export async function toolsForWorkItemFor(deps: ToolProxyDeps, job: Job): Promise<Record<string, unknown> | null> {
  if (!job.claim_token) return null;
  const sendChannels = await resolveSendChannelsFor(deps.configStore, job.dispatch?.tools as Record<string, unknown> | undefined).catch(() => [] as string[]);
  const sendDef = sendChannels.length ? sendToolDef(sendChannels).function : null;

  const r = await resolveAllowedToolsFor(deps.configStore, job, null).catch(async (e) => {
    await deps.stateStore.appendAudit({ ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event: 'tools_unavailable', detail: { error: String(e).slice(0, 200) } }).catch(() => undefined);
    return null;
  });
  if (r && !r.allowed.length) {
    await deps.stateStore.appendAudit({
      ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event: 'tools_locked',
      detail: {
        locked_by_subject: r.lockedBySubject,
        sources: r.sources.map((source) => ({
          provider: source.provider.name,
          locked: source.lockedBySubject,
          subject_field: String(source.sourceCfg.subject_field ?? '') || null,
        })),
      },
    }).catch(() => undefined);
  }
  const bizAllowed = r && r.allowed.length ? r.allowed : [];
  if (!bizAllowed.length && !sendDef) return null;

  const note = await approvedNoteForJobFor(deps.configStore, job.job_id);
  const progressive = bizAllowed.length > TOOL_INLINE_MAX;
  const confirmRequired = (t: ToolDefinition): boolean => t.confirmRequired || !!t.confirmWhen?.length;
  const sendInline = sendDef ? [{ name: SEND_TOOL_NAME, description: sendDef.description, parameters: sendDef.parameters, scope: 'builtin.send', risk: 'low', confirm_required: false, readonly: false, idempotent: false }] : [];
  const sendCat = sendDef ? [{ name: SEND_TOOL_NAME, summary: String(sendDef.description).split('。')[0]!.slice(0, 80), scope: 'builtin.send', risk: 'low', confirm_required: false }] : [];
  return {
    invoke_url: `/jobs/${job.job_id}/tools/invoke`,
    tool_token: toolTokenFor(job.job_id, job.claim_token, deps.cfg.server.token),
    max_calls: r ? maxCallsOf(r.toolsCfg) : 5,
    mode: progressive ? 'catalog' : 'inline',
    ...(progressive
      ? {
          defs_url: `/jobs/${job.job_id}/tools/defs`,
          catalog: [...sendCat, ...bizAllowed.map((t) => ({ name: t.name, summary: toolSummary(t), scope: t.scope, risk: t.risk, confirm_required: confirmRequired(t), confirm_when: t.confirmWhen ?? [] }))],
        }
      : { defs: [...sendInline, ...bizAllowed.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema, scope: t.scope, risk: t.risk, confirm_required: confirmRequired(t), confirm_when: t.confirmWhen ?? [], readonly: t.readonly, idempotent: t.idempotent }))] }),
    ...(note ? { approved_note: note } : {}),
  };
}

function assertToolToken(deps: ToolProxyDeps, job: Job, presented: string): boolean {
  if (job.status !== 'dispatched' || !job.claim_token) return false;
  const expect = Buffer.from(toolTokenFor(job.job_id, job.claim_token, deps.cfg.server.token));
  const got = Buffer.from(presented);
  return !!presented && got.length === expect.length && timingSafeEqual(got, expect);
}

export async function handleToolDefsFor(deps: ToolProxyDeps, req: IncomingMessage, res: ServerResponse, jobId: string, presented: string, names: string[]): Promise<void> {
  const job = await deps.stateStore.getJob(jobId);
  if (!job) { send(res, 404, { error: 'job 不存在' }); return; }
  if (job.status !== 'dispatched' || !job.claim_token) { send(res, 401, { error: 'tool_token 已失效（任务非执行中）' }); return; }
  if (!assertToolToken(deps, job, presented)) { send(res, 401, { error: 'tool_token 无效' }); return; }
  let sendFnDef: { name: string; description: string; parameters: Record<string, unknown> } | null = null;
  if (names.map(String).includes(SEND_TOOL_NAME)) {
    const chs = await resolveSendChannelsFor(deps.configStore, job.dispatch?.tools as Record<string, unknown> | undefined).catch(() => [] as string[]);
    if (chs.length) sendFnDef = sendToolDef(chs).function;
  }
  let runtime: ToolRuntime | 'subject_locked' | undefined;
  try { runtime = await assembleToolRuntimeFor(deps.configStore, deps.stateStore, deps.toolIndex, job, null, deps.cfg, deps.now, deps.sleep); }
  catch (e) { send(res, 400, { error: errMsg(e) }); return; }
  const bizDefs = runtime && runtime !== 'subject_locked' ? (await runtime.lookup(names)).map((x) => x.function) : [];
  const all = [...(sendFnDef ? [sendFnDef] : []), ...bizDefs];
  if (!all.length) { send(res, 400, { error: '该任务未配置工具' }); return; }
  send(res, 200, { defs: all });
}

export async function handleToolInvokeFor(deps: ToolProxyDeps, req: IncomingMessage, res: ServerResponse, jobId: string, presented: string): Promise<void> {
  const job = await deps.stateStore.getJob(jobId);
  if (!job) { send(res, 404, { error: 'job 不存在' }); return; }
  if (job.status !== 'dispatched' || !job.claim_token) { send(res, 401, { error: 'tool_token 已失效（任务非执行中）' }); return; }
  if (!assertToolToken(deps, job, presented)) { send(res, 401, { error: 'tool_token 无效' }); return; }
  const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
  const tool = String(body['tool'] ?? '');
  if (!tool) { send(res, 400, { error: 'tool 必填' }); return; }
  const args = (body['arguments'] as Record<string, unknown>) ?? {};
  if (tool === SEND_TOOL_NAME) {
    const sendChannels = await resolveSendChannelsFor(deps.configStore, job.dispatch?.tools as Record<string, unknown> | undefined).catch(() => [] as string[]);
    if (!sendChannels.length) { send(res, 400, { error: '本路由未开放主动发送渠道' }); return; }
    if (deps.configStore && (await deps.configStore.observability.countAuditEvents(job.job_id, 'builtin_send').catch(() => 0)) >= SEND_MAX_CALLS) {
      send(res, 200, { ok: false, text: `本任务主动发消息次数已达上限（${SEND_MAX_CALLS}）。` }); return;
    }
    const out = await runSendMessageFor(deps.configStore, job, sendChannels, args,
      (event, detail) => { void deps.stateStore.appendAudit({ ts: deps.now(), job_id: job.job_id, request_id: job.request_id, event, detail }).catch(() => undefined); })
      .catch((e) => ({ ok: false, text: `发送失败：${String(e).slice(0, 200)}` }));
    send(res, 200, out); return;
  }
  let runtime: ToolRuntime | 'subject_locked' | undefined;
  try { runtime = await assembleToolRuntimeFor(deps.configStore, deps.stateStore, deps.toolIndex, job, null, deps.cfg, deps.now, deps.sleep); }
  catch (e) { send(res, 400, { error: errMsg(e) }); return; }
  if (!runtime || runtime === 'subject_locked') { send(res, 400, { error: '该任务未配置工具' }); return; }
  if (deps.configStore && (await deps.configStore.observability.countAuditEvents(job.job_id, 'tool_call').catch(() => 0)) >= runtime.maxCalls) {
    send(res, 429, { error: `本任务工具调用次数已达上限（${runtime.maxCalls}）` }); return;
  }
  const out = await runtime.invoke(tool, args)
    .catch((e) => ({ ok: false, text: `工具调用被中枢拒绝：${String(e).slice(0, 200)}`, status: 0 }));
  send(res, 200, out);
}
