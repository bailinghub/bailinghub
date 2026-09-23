import { ProviderFailure } from './provider-failure';
import { isModelTool, modelToolDescriptor } from './model-tools';
import { serviceAvailability } from './service-availability';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readBody, send } from '../../app/http';
import { resolveLlmCredential } from '../../core/runtime/credential-resolver';
import type { AppConfig } from '../../core/config/config';
import type { CredentialStoreLike } from '../../core/runtime/credential-resolver';
import type { UsageService } from './contracts';
import { UsageError, usageAssert } from './errors';
import { authenticateUsageRequest, getUsageIdentity, usageFields, usageString, type UsageSessionContext } from './identity';
import { usageHttpError } from './http';
import { canonicalJson, executeProvider, normalizeModelRequest, providerBody, type UsageModelRequest } from './provider';
import { UsageStreamWriter } from './stream-http';
import { getBillingRepository } from './billing-repository';
import type { UsageRepository } from './repository';
import { referencePricing } from './pricing';
import { executeModelTool, modelToolBody, modelToolEndpoint } from './model-tool-provider';

export interface UsageGatewayDeps {
  usage: UsageRepository | null;
  cfg: Pick<AppConfig, 'llmCredentials'>;
  credentials?: CredentialStoreLike | null;
  isPaused?: () => boolean;
  fetcher?: typeof fetch;
}

const responseCleanup = new WeakMap<UsageRepository, number>();
function scheduleResponseCleanup(repository: UsageRepository): void {
  const now = Date.now();
  if (now - (responseCleanup.get(repository) ?? 0) < 60_000) return;
  responseCleanup.set(repository, now);
  // Bounded maintenance is independent of admission and model delivery. A failed
  // cleanup is retried on later traffic; expired bodies are never returned meanwhile.
  const tokens = getBillingRepository(repository);
  void Promise.allSettled([tokens.cleanupExpiredResponses(now), tokens.reconcilePendingUsage()]);
}

export const MODEL_GATEWAY_CAPABILITIES = {
  schema: 'bailing.model-gateway.v1', supported: true, orchestration: 'host', streaming: true, provider_response: 'bailing.provider-response.v1', settlement: 'asynchronous',
  model_tools: { schema: 'bailing.model-tools.v1', directory: true, execution: true, tools_path: '/usage/v1/model/tools' },
  requests_path: '/usage/v1/model/requests', models_path: '/usage/v1/model/models',
  summary_path: '/usage/v1/model/summary', billing_unit: 'USD', turn_required: false,
} as const;

export interface ModelInput {
  operation_id: string; service_id?: string; conversation_id?: string; turn_id?: string;
  messages: Record<string, unknown>[]; tools?: Record<string, unknown>[];
  tool_choice?: unknown; temperature?: number; provider_options?: Record<string, unknown>;
}
export function normalizeModelGatewayRequest(value: unknown): ModelInput {
  const body = usageFields(value, ['operation_id','service_id','conversation_id','turn_id','messages','tools','tool_choice','temperature','provider_options'], ['operation_id','messages']);
  const operation_id = usageString(body.operation_id, 'operation_id', 191);
  for (const key of ['service_id','conversation_id','turn_id'] as const) if (body[key] !== undefined) usageString(body[key], key, 191);
  const { service_id, conversation_id, turn_id, ...content } = body;
  normalizeModelRequest(content);
  return { ...body, operation_id } as unknown as ModelInput;
}
export interface ModelToolInput { operation_id:string; service_id:string; arguments:Record<string,unknown>; conversation_id?:string;turn_id?:string }
export function normalizeModelToolRequest(value:unknown):ModelToolInput {
 const b=usageFields(value,['operation_id','service_id','arguments','conversation_id','turn_id'],['operation_id','service_id','arguments']);
 for(const k of ['operation_id','service_id','conversation_id','turn_id']) if(b[k]!==undefined) usageString(b[k],k,191);
 usageAssert(b.arguments && typeof b.arguments==='object' && !Array.isArray(b.arguments),'USAGE_INVALID_INPUT','工具参数无效。',400);
 return b as unknown as ModelToolInput;
}
function modelPayload(input: ModelInput): UsageModelRequest {
  const { service_id: _service, conversation_id: _conversation, turn_id: _turn, ...content } = input;
  return content;
}
/** Model membership comes from the current plan; a single-service credential remains restricted. */
export function modelAllowedServices(actor: UsageSessionContext, serviceIds: string[]): string[] {
  return actor.modelAccess === 'token_gateway' ? serviceIds : serviceIds.filter(id => id === actor.serviceId);
}
export function modelDescriptor(service: UsageService, multiplier = 1) {
  return { schema: 'bailing.usage-model.v1', service_id: service.id, service_revision: service.revision,
    label: service.label, model: service.config.model, state: service.state, orchestration: 'host', streaming: true,
    billing_rate: { multiplier },
    input_formats: ['text','image_url'], model_modalities: service.config.inputModalities ?? null,
    context_window_tokens: service.config.contextWindowTokens ?? null, max_input_bytes: service.config.maxInputBytes,
    input_limit_scope: 'serialized_provider_request', max_messages: 1024, max_tools: 128,
    max_output_tokens: service.config.maxOutputTokens, timeout_ms: service.config.timeoutMs,
    provider_options: ['max_tokens','max_completion_tokens','top_p','stop','seed','presence_penalty','frequency_penalty','parallel_tool_calls','response_format','reasoning_effort','enable_thinking','thinking','verbosity'] };
}

/** One durable request, one provider dispatch; accounting never drives the local agent loop. */
export async function runModelRequest(deps: UsageGatewayDeps, actor: UsageSessionContext, input: ModelInput | ModelToolInput, stream?: UsageStreamWriter) {
  usageAssert(deps.usage, 'USAGE_UNSUPPORTED', '模型网关不可用。', 503);
  const repository = deps.usage, tokens = getBillingRepository(repository);
  const toolRequest = 'arguments' in input;
  const serviceId = input.service_id ?? actor.serviceId;
  const requestHash = createHash('sha256').update(canonicalJson({ ...input, service_id: serviceId })).digest('hex');
  const previous = await tokens.findRequest(actor, input.operation_id);
  if (previous) {
    usageAssert(previous.requestHash === requestHash, 'USAGE_IDEMPOTENCY_CONFLICT', '原请求标识已关联其他内容。');
    return tokens.view(previous);
  }
  usageAssert(!deps.isPaused?.(), 'USAGE_SERVICE_PAUSED', '模型服务维护中；原请求结果仍可查询。', 503);
  const current = await tokens.summary(actor.accountId);
  usageAssert(current.grant, 'SERVICE_NOT_ENTITLED', '尚未开通套餐。', 403);
  if (!modelAllowedServices(actor, current.plan?.serviceIds ?? []).includes(serviceId))
    throw new UsageError('SERVICE_NOT_ENTITLED', '当前套餐已不包含所选模型，请刷新模型列表并重新选择。原请求请按原标识核对。', 403, { next_action: 'select_model' });
  const service = await repository.getService(serviceId);
  usageAssert(service?.state === 'active', 'USAGE_SERVICE_UNAVAILABLE', '该模型服务暂不可用。', 503);
  usageAssert(isModelTool(service) === toolRequest, 'USAGE_SERVICE_PURPOSE_MISMATCH', '模型工具不能作为对话模型调用，请刷新模型目录。', 400);
  const credential = await resolveLlmCredential(service.config.credential, deps.cfg, deps.credentials);
  usageAssert(credential, 'USAGE_SERVICE_UNAVAILABLE', '模型连接尚未就绪。', 503);
  const body = toolRequest ? modelToolBody(service.config, input.arguments) : providerBody(modelPayload(input), service.config, Boolean(stream));
  if (toolRequest) modelToolEndpoint(credential.credential, service.config, body);
  const priceSnapshot = await referencePricing(repository).snapshot(service.config.pricing);
  let request = await tokens.admit({ actor, operationId: input.operation_id, serviceId,
    conversationId: input.conversation_id ?? null, turnId: input.turn_id ?? null,
    requestHash, priceSnapshot, expectedServiceRevision: service.revision, serviceConfig: service.config, model: service.config.model });
  if (!request.created) return tokens.view(request);
  if (deps.isPaused?.()) {
    await tokens.cancel(actor, input.operation_id);
    throw new UsageError('USAGE_SERVICE_PAUSED', '模型服务维护中。', 503);
  }
  try { request = await tokens.commitDispatch(request.id, actor); }
  catch (error) {
    // Lost commit ACK is never a permit to send a second provider request.
    const saved = await tokens.findRequest(actor, input.operation_id).catch(() => null);
    if (saved && saved.state !== 'admitted') return tokens.view(saved);
    if (saved) await tokens.cancel(actor, input.operation_id);
    throw error;
  }
  usageAssert(request.fence && request.state === 'dispatch_committed', 'USAGE_PENDING', '请核对原请求。', 503);
  const complete = async () => {
  try {
    await stream?.emit('started');
    const result = toolRequest ? await executeModelTool(credential.credential, request.serviceConfig, body, deps.fetcher) : await executeProvider(credential.credential, request.serviceConfig, body, deps.fetcher,
      stream ? packet => stream.emit('provider', { provider: packet }) : undefined);
    request = await tokens.recordCompletion(request.id, request.fence!, { response: result.response,
      ...(result.usage ? { usage: result.usage } : {}), ...((result.rawUsage || result.usage) ? { rawUsage: { ...result.rawUsage, requestCount: 1, ...(!toolRequest ? { webSearchCount: 0 } : {}) } } : {}),
      ...(result.executionId ? { executionId: result.executionId } : {}) });
  } catch (error) {
    const reason = error instanceof UsageError ? error.code : 'USAGE_TRANSPORT_UNCERTAIN';
    try { request = error instanceof ProviderFailure
      ? await tokens.recordProviderFailure(request.id, request.fence!, error)
      : await tokens.markUnknown(request.id, request.fence!, reason); }
    catch { throw new UsageError('USAGE_PENDING', '原请求待核对，请保留原标识，不要重新执行。', 503); }
  }
    return tokens.view(request);
  };
  if (toolRequest) {
    // Return the durable dispatch record promptly. Disconnecting never regenerates an image.
    void complete().then(result=>tokens.scheduleSettlement(result.operation_id,actor)).catch(()=>{});
    return tokens.view(request);
  }
  return complete();
}

export async function handleModelGatewayApiFor(deps: UsageGatewayDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/usage/v1/model/')) return false;
  let stream: UsageStreamWriter | undefined;
  try {
    usageAssert(deps.usage, 'USAGE_UNSUPPORTED', '模型网关不可用。', 503);
    const repository = deps.usage, tokens = getBillingRepository(repository);
    usageAssert(await tokens.ready(), 'USAGE_UNSUPPORTED', '模型网关尚未就绪，请核对版本与迁移。', 503);
    usageAssert(!url.search, 'USAGE_INVALID_INPUT', '此接口不接受查询参数。', 400);
    const actor = await authenticateUsageRequest(getUsageIdentity(repository), req);
    scheduleResponseCleanup(repository);
    if (path === '/usage/v1/model/summary' && req.method === 'GET') {
      const summary = await tokens.summary(actor.accountId);
      const ids = modelAllowedServices(actor, summary.plan?.serviceIds ?? []);
      const scopedPlan = summary.plan ? { ...summary.plan, serviceIds: ids } : null;
      send(res, 200, { ...summary, plan: scopedPlan, user_id: actor.userId, service_id: actor.serviceId }); return true;
    }
    if (['/usage/v1/model/models','/usage/v1/model/tools'].includes(path) && req.method === 'GET') {
      const summary = await tokens.summary(actor.accountId);
      const active = ['active','depleted'].includes(summary.presentation.state); // Same authoritative DB clock as the allowance summary.
      const ids = active ? modelAllowedServices(actor, summary.plan?.serviceIds ?? []) : [];
      const services = await Promise.all(ids.map(id => repository.getService(id)));
      const toolsDirectory = path.endsWith('/tools');
      const selected = services.filter((service): service is UsageService => Boolean(service) && isModelTool(service!) === toolsDirectory);
      const checked = await Promise.all(selected.map(async service => ({service,availability:await serviceAvailability(repository,service)})));
      const available = checked.filter(item=>item.availability.state === 'ready').map(item=>item.service);
      // Only plan/credential-selected targets are described, never the instance-wide service catalog.
      const unavailable = checked.filter(item=>item.availability.state !== 'ready').map(({service,availability})=>({
        service_id:service.id,service_revision:service.revision,label:service.label,...availability,
      }));
      if (toolsDirectory) {
        send(res, 200, { schema: 'bailing.model-tools.v1', account_id: actor.accountId, user_id: actor.userId,
          plan_id: summary.plan?.id ?? null, plan_revision: summary.plan?.revision ?? null, orchestration: 'host', execution: true,
          unavailable_items: unavailable,
          items: available.map(service => modelToolDescriptor(service, summary.plan?.multiplier)) }); return true;
      }
      send(res, 200, { schema: 'bailing.model-models.v1', account_id: actor.accountId, user_id: actor.userId,
        selection: 'plan', plan_id: summary.plan?.id ?? null, plan_revision: summary.plan?.revision ?? null,
        unavailable_items: unavailable,
        default_service_id: available.some(service => service.id === actor.serviceId) ? actor.serviceId : available[0]?.id ?? null,
        items: available.map(service => modelDescriptor(service, summary.plan?.multiplier)) }); return true;
    }
    if (path === '/usage/v1/model/tools/requests' && req.method === 'POST') {
      const input = normalizeModelToolRequest(await readBody(req,16*1024*1024+4096));
      const result = await runModelRequest(deps,actor,input);
      send(res,result.result_state === 'pending' || result.result_state === 'unknown' ? 202 : 200,result); return true;
    }
    if (['/usage/v1/model/requests','/usage/v1/model/requests/stream'].includes(path) && req.method === 'POST') {
      const input = normalizeModelGatewayRequest(await readBody(req, 16 * 1024 * 1024 + 4096));
      if (path.endsWith('/stream')) stream = new UsageStreamWriter(res, input.operation_id);
      const result = await runModelRequest(deps, actor, input, stream);
      if (stream) { await stream.emit('operation', { operation: result }); stream.end(); }
      else send(res, result.result_state === 'pending' || result.result_state === 'unknown' ? 202 : 200, result);
      // Response is closed before financial aggregation; original durable evidence
      // lets the existing maintenance sweep recover a failed or interrupted settlement.
      tokens.scheduleSettlement(result.operation_id, actor);
      return true;
    }
    const match = path.match(/^\/usage\/v1\/model\/requests\/([^/]+)(\/cancel)?$/);
    if (match) {
      const id = usageString(decodeURIComponent(match[1]!), 'operation_id', 191);
      if (match[2] && req.method === 'POST') {
        usageFields(await readBody(req, 1024), []);
        send(res, 200, tokens.view(await tokens.cancel(actor, id))); return true;
      }
      if (!match[2] && req.method === 'GET') {
        const request = await tokens.findRequest(actor, id);
        usageAssert(request, 'USAGE_OPERATION_NOT_FOUND', '未找到原请求，未发送新的模型调用。', 404);
        send(res, 200, tokens.view(request)); return true;
      }
    }
    throw new UsageError('USAGE_NOT_FOUND', '模型接口不存在。', 404);
  } catch (error) {
    if (stream?.open) stream.end(); else usageHttpError(res, error);
    return true;
  } finally { stream?.stop(); }
}
