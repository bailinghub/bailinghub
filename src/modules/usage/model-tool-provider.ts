import type { ResolvedLlmCredential } from '../../core/runtime/credential-resolver';
import type { UsageServiceConfig } from './contracts';
import { UsageError, usageAssert } from './errors';
import { object, type ProviderResult } from './provider';
import { ProviderFailure, httpProviderFailure, safeProviderIdentifier } from './provider-failure';

/** The host supplies declared arguments only; no arbitrary endpoint, credential or provider routing. */
export function modelToolBody(config: UsageServiceConfig, args: unknown): Record<string, unknown> {
  const tool = config.tool;
  usageAssert(tool && tool.adapter !== 'pending', 'MODEL_TOOL_ADAPTER_NOT_READY', '该工具目前仅声明，尚未配置执行适配。', 400);
  usageAssert(object(args), 'USAGE_INVALID_INPUT', '工具参数应为对象。', 400);
  usageAssert(Object.keys(args).every(k => tool.parameters.some(p => p.name === k)), 'USAGE_INVALID_INPUT', '存在未声明的工具参数。', 400);
  for (const p of tool.parameters) {
    const v = args[p.name];
    if (v === undefined) { usageAssert(!p.required, 'USAGE_INVALID_INPUT', `缺少工具参数 ${p.name}。`, 400); continue; }
    usageAssert(typeof v === p.type && (typeof v !== 'number' || Number.isFinite(v)), 'USAGE_INVALID_INPUT', `工具参数 ${p.name} 类型错误。`, 400);
  }
  usageAssert(typeof args.prompt === 'string' && args.prompt.trim().length > 0, 'USAGE_INVALID_INPUT', '请提供生成提示词。', 400);
  if (args.n !== undefined) usageAssert(Number.isInteger(args.n) && Number(args.n) >= 1 && Number(args.n) <= (tool.adapter.startsWith('aliyun-image') ? 6 : 10), 'USAGE_INVALID_INPUT','图片数量无效。',400);
  if (args.seed !== undefined) usageAssert(Number.isSafeInteger(args.seed) && Number(args.seed) >= 0 && Number(args.seed) <= 2147483647, 'USAGE_INVALID_INPUT','seed无效。',400);
  const body = { model:config.model,...args };
  usageAssert(Buffer.byteLength(JSON.stringify(body)) <= config.maxInputBytes, 'USAGE_INPUT_LIMIT','生成参数超过服务传输大小限制。',400);
  return body;
}
const count=(v:unknown):v is number=>typeof v==='number' && Number.isSafeInteger(v) && v>=0;
const tier=(v:unknown)=>typeof v==='string' ? v.match(/(?:^|_)(512|1k|2k|4k)$/i)?.[1]?.toLowerCase() : undefined;
/** A completed image response is usage evidence; missing usage is not invented Token usage. */
export function imageProviderResult(adapter:string, value:unknown, requestId:string|null):ProviderResult {
  usageAssert(object(value) && Array.isArray(value.data) && value.data.length > 0 && value.data.length <= 10, 'USAGE_PROVIDER_INVALID','生成服务未返回有效图片结果。',502);
  const outputs = value.data.map(item=> {
    usageAssert(object(item), 'USAGE_PROVIDER_INVALID','生成结果格式异常。',502);
    if(typeof item.url === 'string') {let url:URL; try{url=new URL(item.url);}catch{throw new UsageError('USAGE_PROVIDER_INVALID','生成结果地址无效。',502);}
      usageAssert(['https:','http:'].includes(url.protocol) && !url.username && !url.password, 'USAGE_PROVIDER_INVALID','生成结果地址无效。',502);
      return {type:'image',url:item.url,...(typeof item.media_type==='string'?{mime_type:item.media_type}:{})};}
    usageAssert(typeof item.b64_json==='string' && /^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json), 'USAGE_PROVIDER_INVALID','生成结果缺少图片内容。',502);
    return {type:'image',base64:item.b64_json,...(typeof item.media_type==='string'?{mime_type:item.media_type}:{})};
  });
  const u=object(value.usage)?value.usage:{};
  const raw:Record<string,unknown>={...u,requestCount:1};
  if(adapter.startsWith('aliyun-image')) {
    if(count(u.input_image_count))raw.inputImageCount=u.input_image_count;
    if(count(u.output_image_count))raw.outputImageCount=u.output_image_count;
    if(tier(u.input_image_type))raw.inputVariant=tier(u.input_image_type);
    if(tier(u.output_image_type))raw.outputVariant=tier(u.output_image_type);
    if(count(u.output_width)&&count(u.output_height)&&count(u.output_image_count))raw.outputPixelCount=u.output_width*u.output_height*u.output_image_count;
  } else {
    // The implemented adapter is text-to-image only; output evidence supplies actual count.
    raw.inputImageCount=0;raw.outputImageCount=outputs.length;
    if(typeof u.resolution==='string')raw.outputVariant=tier(u.resolution);
    // General text Tokens cannot be assumed to be image Tokens.
    if(count(u.image_tokens))raw.outputImageTokens=u.image_tokens;
    if(object(u.completion_tokens_details)&&count(u.completion_tokens_details.image_tokens))raw.outputImageTokens=u.completion_tokens_details.image_tokens;
  }
  const usage=count(u.prompt_tokens)&&count(u.completion_tokens)?{inputTokens:u.prompt_tokens,outputTokens:u.completion_tokens}:undefined;
  return {response:{schema:'bailing.model-tool-result.v1',outputs,...(requestId?{provider_request_id:requestId}:{})},executionId:requestId,...(usage?{usage}:{}),rawUsage:raw};
}
/** Explicit adapter choice, never a retry or silent fallback to another API. */
export function modelToolEndpoint(credential: ResolvedLlmCredential, config: UsageServiceConfig, body: Record<string, unknown>) {
  if (config.tool?.adapter === 'aliyun-image-native') {
    const base = new URL(credential.base_url);
    usageAssert(!base.username && !base.password && !base.search && !base.hash
      && ['','/','/api/v1','/api/v1/','/compatible-mode/v1','/compatible-mode/v1/'].includes(base.pathname),
    'USAGE_INVALID_INPUT','原生图片接口请配置服务根地址或标准 API 基础地址。',400);
    const {model, prompt, ...parameters} = body;
    if (typeof parameters.size === 'string') parameters.size = parameters.size.replace(/^(\d+)x(\d+)$/, '$1*$2');
    return {url: new URL('/api/v1/services/aigc/multimodal-generation/generation', base).href,
      body: {model, input: {messages:[{role:'user',content:[{text:prompt}]}]}, parameters}};
  }
  const suffix=config.tool?.adapter==='aliyun-image'?'images/generations':'images';
  return {url:`${credential.base_url.replace(/\/+$/,'')}/${suffix}`,body};
}
async function boundedBody(response: Response, maximum: number): Promise<string> {
  if (!response.body) return '';
  const reader=response.body.getReader(), chunks:Uint8Array[]=[]; let size=0;
  try {
    for (;;) {const {value,done}=await reader.read();if(done)break;size+=value.length;
      if(size>maximum){await reader.cancel();throw new UsageError('USAGE_PROVIDER_INVALID','生成结果超过传输容量。',502);}chunks.push(value);}
    return Buffer.concat(chunks).toString('utf8');
  } finally {reader.releaseLock();}
}
export async function executeModelTool(credential:ResolvedLlmCredential, config:UsageServiceConfig, body:Record<string,unknown>, fetcher:typeof fetch=fetch):Promise<ProviderResult> {
  const target=modelToolEndpoint(credential,config,body);
  let response: Response;
  try {
    response=await fetcher(target.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(config.timeoutMs),headers:{authorization:`Bearer ${credential.api_key}`,'content-type':'application/json'},body:JSON.stringify(target.body)});
  } catch {
    throw new ProviderFailure(false,{code:'USAGE_TRANSPORT_UNCERTAIN',message:'连接中断，原生成请求的结果尚无法确认。',retryable:false,next_action:'inspect_original'});
  }
  const secrets=[credential.api_key,credential.base_url];
  const requestId=safeProviderIdentifier(response.headers.get('x-request-id') ?? response.headers.get('x-dashscope-request-id'),secrets);
  if(!response.ok) {
    let value:unknown;
    try {value=JSON.parse(await boundedBody(response,16*1024));}catch { /* HTTP status remains authoritative; body is discarded. */ }
    throw httpProviderFailure(response.status,value,requestId,secrets);
  }
  try {
    let value=JSON.parse(await boundedBody(response,24*1024*1024));
    const id=requestId ?? safeProviderIdentifier(value.request_id ?? value.id,secrets) ?? null;
    if(config.tool?.adapter==='aliyun-image-native') {
      usageAssert(Array.isArray(value.output?.choices),'USAGE_PROVIDER_INVALID','生成结果格式异常。',502);
      const images=value.output.choices.flatMap((choice:any)=>Array.isArray(choice.message?.content)?choice.message.content:[])
        .filter((part:any)=>typeof part?.image==='string').map((part:any)=>({url:part.image}));
      value={data:images,usage:value.usage};
    }
    return imageProviderResult(config.tool!.adapter,value,id);
  } catch {
    throw new ProviderFailure(false,{code:'USAGE_PROVIDER_INVALID',message:'生成服务已响应，但结果无法解析；请核对原请求。',http_status:response.status,
      ...(requestId?{provider_request_id:requestId}:{}),retryable:false,next_action:'inspect_original'});
  }
}
