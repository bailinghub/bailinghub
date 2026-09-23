import type { ResolvedLlmCredential } from '../../core/runtime/credential-resolver';
import type { UsageServiceConfig } from './contracts';
import { UsageError, usageAssert } from './errors';
import { readProviderExchange } from './provider-stream';

export type JsonObject = Record<string, unknown>;
export interface UsageModelRequest {
  operation_id: string;
  messages: JsonObject[];
  tools?: JsonObject[];
  tool_choice?: unknown;
  temperature?: number;
  provider_options?: JsonObject;
}
export interface ProviderResult {
  response: JsonObject;
  executionId: string | null;
  usage?: { inputTokens: number; outputTokens: number };
  rawUsage?: JsonObject;
}

export function object(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function onlyKeys(value: JsonObject, allowed: string[]): void {
  usageAssert(Object.keys(value).every(key => allowed.includes(key)), 'USAGE_UNSUPPORTED_INPUT', 'This input field is not supported by the model gateway.', 400);
}
function nonempty(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function tokenCount(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }

/** Copy the host's supported model wire format; credentials and routing remain service-owned. */
export function normalizeModelRequest(value: unknown): UsageModelRequest {
  usageAssert(object(value), 'USAGE_INVALID_INPUT', 'A JSON object is required.', 400);
  onlyKeys(value, ['operation_id', 'messages', 'tools', 'tool_choice', 'temperature', 'provider_options']);
  usageAssert(nonempty(value.operation_id, 191), 'USAGE_INVALID_INPUT', 'An original operation ID is required.', 400);
  usageAssert(Array.isArray(value.messages) && value.messages.length > 0 && value.messages.length <= 1024, 'USAGE_INVALID_INPUT', 'A bounded message list is required.', 400);
  for (const message of value.messages) {
    usageAssert(object(message), 'USAGE_INVALID_INPUT', 'Invalid message.', 400);
    onlyKeys(message, ['role', 'content', 'name', 'tool_call_id', 'tool_calls', 'reasoning_content']);
    usageAssert(['system', 'developer', 'user', 'assistant', 'tool'].includes(String(message.role)), 'USAGE_UNSUPPORTED_INPUT', 'Unsupported message role.', 400);
    usageAssert(typeof message.content === 'string' || validContentParts(message.content) || (message.role === 'assistant' && message.content === null && Array.isArray(message.tool_calls)), 'USAGE_UNSUPPORTED_INPUT', 'Only text, image content parts and function-call messages are supported.', 400);
    if (message.reasoning_content !== undefined) usageAssert(message.role === 'assistant' && typeof message.reasoning_content === 'string', 'USAGE_INVALID_INPUT', 'Invalid assistant reasoning content.', 400);
    if (message.name !== undefined) usageAssert(nonempty(message.name, 128), 'USAGE_INVALID_INPUT', 'Invalid message name.', 400);
    if (message.role === 'tool') usageAssert(nonempty(message.tool_call_id, 256), 'USAGE_INVALID_INPUT', 'A tool result requires its original call ID.', 400);
    if (message.tool_calls !== undefined) {
      usageAssert(message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length <= 128, 'USAGE_INVALID_INPUT', 'Invalid function calls.', 400);
      for (const call of message.tool_calls) {
        usageAssert(object(call) && object(call.function), 'USAGE_INVALID_INPUT', 'Invalid function call.', 400);
        onlyKeys(call, ['id', 'type', 'function']); onlyKeys(call.function, ['name', 'arguments']);
        usageAssert(nonempty(call.id, 256) && call.type === 'function' && nonempty(call.function.name, 128) && typeof call.function.arguments === 'string', 'USAGE_INVALID_INPUT', 'Invalid function call.', 400);
      }
    }
  }
  if (value.tools !== undefined) {
    usageAssert(Array.isArray(value.tools) && value.tools.length <= 128, 'USAGE_INVALID_INPUT', 'Too many function declarations.', 400);
    for (const tool of value.tools) {
      usageAssert(object(tool) && tool.type === 'function' && object(tool.function), 'USAGE_UNSUPPORTED_INPUT', 'Only function declarations are supported.', 400);
      onlyKeys(tool, ['type', 'function']); onlyKeys(tool.function, ['name', 'description', 'parameters', 'strict']);
      usageAssert(nonempty(tool.function.name, 128) && object(tool.function.parameters), 'USAGE_INVALID_INPUT', 'A function requires its name and full schema.', 400);
      if (tool.function.description !== undefined) usageAssert(typeof tool.function.description === 'string', 'USAGE_INVALID_INPUT', 'Invalid function description.', 400);
      if (tool.function.strict !== undefined) usageAssert(typeof tool.function.strict === 'boolean', 'USAGE_INVALID_INPUT', 'Invalid strict flag.', 400);
    }
  }
  if (value.tool_choice !== undefined) {
    const choice = value.tool_choice;
    const named = object(choice) && choice.type === 'function' && object(choice.function) && nonempty(choice.function.name, 128);
    usageAssert(['auto', 'none', 'required'].includes(String(choice)) || named, 'USAGE_UNSUPPORTED_INPUT', 'Invalid tool choice.', 400);
    if (named) { onlyKeys(choice as JsonObject, ['type', 'function']); onlyKeys((choice as JsonObject).function as JsonObject, ['name']); }
  }
  if (value.temperature !== undefined) usageAssert(typeof value.temperature === 'number' && Number.isFinite(value.temperature) && value.temperature >= 0 && value.temperature <= 2, 'USAGE_INVALID_INPUT', 'Temperature must be between zero and two.', 400);
  if (value.provider_options !== undefined) validateProviderOptions(value.provider_options);
  return value as unknown as UsageModelRequest;
}

// Gateway transport formats do not promise that the configured provider/model supports every modality.
function validContentParts(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(part => {
    if (!object(part)) return false;
    if (part.type === 'text') return typeof part.text === 'string' && Object.keys(part).every(k => ['type', 'text'].includes(k));
    if (part.type !== 'image_url' || !object(part.image_url)) return false;
    const image = part.image_url;
    if (typeof image.url !== 'string' || !/^(https?:\/\/|data:image\/[a-zA-Z0-9.+-]+;base64,)/.test(image.url)) return false;
    return Object.keys(part).every(k => ['type', 'image_url'].includes(k))
      && Object.keys(image).every(k => ['url', 'detail'].includes(k))
      && (image.detail === undefined || ['auto', 'low', 'high'].includes(String(image.detail)));
  });
}
const PROVIDER_OPTION_KEYS = ['max_tokens', 'max_completion_tokens', 'top_p', 'stop', 'seed', 'presence_penalty',
  'frequency_penalty', 'parallel_tool_calls', 'response_format', 'reasoning_effort', 'enable_thinking', 'thinking', 'verbosity'];
function validateProviderOptions(value: unknown): asserts value is JsonObject {
  usageAssert(object(value), 'USAGE_INVALID_INPUT', 'Provider options must be an object.', 400);
  onlyKeys(value, PROVIDER_OPTION_KEYS);
  usageAssert(!(value.max_tokens !== undefined && value.max_completion_tokens !== undefined), 'USAGE_INVALID_INPUT', 'Choose one output limit field.', 400);
  for (const key of ['max_tokens', 'max_completion_tokens']) if (value[key] !== undefined)
    usageAssert(Number.isSafeInteger(value[key]) && Number(value[key]) > 0, 'USAGE_INVALID_INPUT', 'Invalid output limit.', 400);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function providerBody(request: UsageModelRequest, config: UsageServiceConfig, streaming = false): JsonObject {
  if (config.inputModalities && !config.inputModalities.includes('image')) usageAssert(
    !request.messages.some(message => Array.isArray(message.content) && message.content.some(part => object(part) && part.type === 'image_url')),
    'USAGE_UNSUPPORTED_INPUT', 'This model service is configured for text input only.', 400);
  const options = request.provider_options ?? {};
  validateProviderOptions(options);
  const outputKey = options.max_completion_tokens === undefined ? 'max_tokens' : 'max_completion_tokens';
  const requested = Number(options[outputKey] ?? config.maxOutputTokens);
  usageAssert(requested <= config.maxOutputTokens, 'USAGE_OUTPUT_LIMIT', 'The requested output limit exceeds the model service limit.', 413);
  const result: JsonObject = { ...options, model: config.model, messages: request.messages, stream: streaming, [outputKey]: requested,
    ...(streaming ? { stream_options: { include_usage: true } } : {}) };
  for (const name of ['tools', 'tool_choice', 'temperature'] as const) if (request[name] !== undefined) result[name] = request[name];
  const actual = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (actual > config.maxInputBytes) throw new UsageError('USAGE_INPUT_LIMIT', 'The complete model request exceeds this service input byte limit.', 413,
    { input_limit: { kind: 'serialized_provider_bytes', actual, allowed: config.maxInputBytes,
      message_count: request.messages.length, tool_count: request.tools?.length ?? 0 } });
  return result;
}
function providerUrl(credential: ResolvedLlmCredential, path: string): string {
  const base = new URL(credential.base_url.endsWith('/') ? credential.base_url : `${credential.base_url}/`);
  usageAssert(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash, 'USAGE_SERVICE_UNAVAILABLE', 'The configured model endpoint is invalid.', 503);
  const result = new URL(path, base);
  usageAssert(result.origin === base.origin && !result.search && !result.hash, 'USAGE_SERVICE_UNAVAILABLE', 'The service endpoint must remain in the configured provider origin.', 503);
  return result.href;
}

export function verifiedUsage(value: unknown): ProviderResult['usage'] {
  if (!object(value) || !tokenCount(value.prompt_tokens) || !tokenCount(value.completion_tokens)) return undefined;
  if (value.total_tokens !== undefined && (!tokenCount(value.total_tokens) || value.total_tokens !== Number(value.prompt_tokens) + Number(value.completion_tokens))) return undefined;
  return { inputTokens: Number(value.prompt_tokens), outputTokens: Number(value.completion_tokens) };
}
/** Transport completion and model semantics are separate. The local adapter owns the latter. */
export async function executeProvider(credential: ResolvedLlmCredential, config: UsageServiceConfig, body: JsonObject, fetcher: typeof fetch = fetch,
  onProvider?: (packet: JsonObject) => Promise<void>): Promise<ProviderResult> {
  const signal = AbortSignal.timeout(config.timeoutMs);
  const response = await fetcher(providerUrl(credential, 'chat/completions'), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.api_key}` }, body: JSON.stringify(body), signal });
  // HTTP error bodies are also returned to the local provider adapter. Do not
  // retry them or mistake a transport-complete error response for a missing body.
  return readProviderExchange(response, onProvider, signal);
}
