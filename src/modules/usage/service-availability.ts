import type { UsageService } from './contracts';
import type { UsageRepository } from './repository';
import { referencePricing, type PriceAvailability } from './pricing';

/** Configuration readiness only; no supplier call and no promise about a future provider response. */
export async function serviceAvailability(repository: UsageRepository, service: UsageService): Promise<PriceAvailability> {
  if (service.state !== 'active') return {state:'unavailable',code:'USAGE_SERVICE_UNAVAILABLE',message:'模型服务已停用。'};
  if (service.config.purpose === 'tool' && service.config.tool?.adapter === 'pending')
    return {state:'unavailable',code:'MODEL_TOOL_ADAPTER_NOT_READY',message:'仅有工具声明，执行适配尚未就绪。'};
  if (service.config.pricing && service.config.pricing.kind !== (service.config.purpose === 'tool' ? 'image' : 'chat'))
    return {state:'unavailable',code:'USAGE_PRICE_NOT_CONFIGURED',message:'参考价格类型与服务用途不一致，请重新配置。'};
  return (await referencePricing(repository).inspect(service.config.pricing)).availability;
}
