import { UsageError } from './errors';

/** Safe diagnostics only: never retain provider messages, bodies, URLs or credentials. */
export interface ProviderDiagnostic {
  code: 'USAGE_PROVIDER_REJECTED' | 'USAGE_PROVIDER_ERROR' | 'USAGE_TRANSPORT_UNCERTAIN' | 'USAGE_PROVIDER_INVALID';
  message: string;
  http_status?: number;
  provider_code?: string;
  provider_request_id?: string;
  retryable: false;
  next_action: 'contact_operator' | 'inspect_original';
}
export class ProviderFailure extends UsageError {
  constructor(readonly rejected: boolean, readonly diagnostic: ProviderDiagnostic) {
    super(diagnostic.code, diagnostic.message, 502);
  }
}
export function safeProviderIdentifier(value: unknown, secrets: string[] = []): string | undefined {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
    || /^(?:sk-|bearer|eyJ)/i.test(value) || secrets.some(s => s && value.includes(s))) return undefined;
  return value;
}
export function httpProviderFailure(status: number, value: unknown, requestId: unknown, secrets: string[] = []): ProviderFailure {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const nested = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : record;
  const provider_code = safeProviderIdentifier(nested.code, secrets);
  const provider_request_id = safeProviderIdentifier(requestId ?? record.request_id, secrets);
  // These HTTP responses reject the request. Timeouts, conflicts and server
  // errors do not prove that generation did not execute and must not be replayed.
  const rejected = [400,401,403,404,405,413,415,422,429].includes(status);
  return new ProviderFailure(rejected, {
    code: rejected ? 'USAGE_PROVIDER_REJECTED' : 'USAGE_PROVIDER_ERROR',
    message: rejected ? '生成服务拒绝了本次请求，请检查模型接口、权限和参数。' : '生成服务返回异常，原请求结果尚无法确认。',
    http_status: status, ...(provider_code ? {provider_code} : {}), ...(provider_request_id ? {provider_request_id} : {}),
    retryable: false, next_action: rejected ? 'contact_operator' : 'inspect_original',
  });
}
