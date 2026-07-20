export interface OpenAiChatStreamResult {
  message: Record<string, unknown>;
  totalTokens: number;
  finishReason: string | null;
  streamed: boolean;
  chunkCount: number;
  contentChars: number;
  firstTokenMs?: number;
}

export interface OpenAiChatStreamOptions {
  onDelta?: (text: string) => void;
  startedAt?: number;
}

interface ToolCallAccumulator {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    const item = record(part);
    return typeof item?.['text'] === 'string' ? item['text'] : '';
  }).join('');
}

function completionFromJson(data: unknown): OpenAiChatStreamResult {
  const root = record(data);
  const choices = Array.isArray(root?.['choices']) ? root['choices'] : [];
  const choice = record(choices[0]);
  const message = record(choice?.['message']);
  if (!message) throw new Error('LLM JSON 响应缺少 choices[0].message');
  const usage = record(root?.['usage']);
  const content = contentText(message['content']);
  return {
    message: { ...message, ...(content ? { content } : {}) },
    totalTokens: Number(usage?.['total_tokens'] ?? 0) || 0,
    finishReason: typeof choice?.['finish_reason'] === 'string' ? choice['finish_reason'] : null,
    streamed: false,
    chunkCount: 0,
    contentChars: content.length,
  };
}

function appendToolCalls(target: Map<number, ToolCallAccumulator>, value: unknown): void {
  if (!Array.isArray(value)) return;
  value.forEach((raw, position) => {
    const part = record(raw);
    if (!part) return;
    const indexValue = Number(part['index']);
    const index = Number.isInteger(indexValue) && indexValue >= 0 ? indexValue : position;
    const current = target.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
    const fn = record(part['function']);
    if (typeof part['id'] === 'string') current.id += part['id'];
    if (typeof part['type'] === 'string') current.type = part['type'];
    if (typeof fn?.['name'] === 'string') current.function.name += fn['name'];
    if (typeof fn?.['arguments'] === 'string') current.function.arguments += fn['arguments'];
    target.set(index, current);
  });
}

function parseSseData(block: string): string | null {
  const data = block.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  return data.length ? data.join('\n') : null;
}

export async function readOpenAiChatCompletion(response: Response, options: OpenAiChatStreamOptions = {}): Promise<OpenAiChatStreamResult> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/event-stream')) {
    return completionFromJson(await response.json());
  }
  if (!response.body) throw new Error('LLM 流式响应没有响应体');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let buffer = '';
  let content = '';
  let role = '';
  let totalTokens = 0;
  let finishReason: string | null = null;
  let chunkCount = 0;
  let firstTokenMs: number | undefined;
  let doneMarker = false;

  const consume = (block: string) => {
    const raw = parseSseData(block);
    if (raw === null) return;
    if (raw.trim() === '[DONE]') { doneMarker = true; return; }
    let payload: unknown;
    try { payload = JSON.parse(raw); }
    catch { throw new Error('LLM 流式响应包含无效 JSON 事件'); }
    chunkCount++;
    const root = record(payload);
    const usage = record(root?.['usage']);
    totalTokens = Math.max(totalTokens, Number(usage?.['total_tokens'] ?? 0) || 0);
    const choices = Array.isArray(root?.['choices']) ? root['choices'] : [];
    const choice = record(choices[0]);
    if (!choice) return;
    if (typeof choice['finish_reason'] === 'string') finishReason = choice['finish_reason'];
    const delta = record(choice['delta']) ?? record(choice['message']);
    if (!delta) return;
    if (typeof delta['role'] === 'string') role = delta['role'];
    appendToolCalls(toolCalls, delta['tool_calls']);
    const text = contentText(delta['content']);
    if (!text) return;
    if (firstTokenMs === undefined) firstTokenMs = Math.max(0, Date.now() - (options.startedAt ?? Date.now()));
    content += text;
    options.onDelta?.(text);
  };

  for (;;) {
    const part = await reader.read();
    buffer += decoder.decode(part.value, { stream: !part.done });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      consume(block);
    }
    if (part.done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!doneMarker && finishReason === null) throw new Error('LLM 流式响应提前结束，未收到完成标记');

  const orderedToolCalls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  return {
    message: {
      role: role || 'assistant',
      content: content || null,
      ...(orderedToolCalls.length ? { tool_calls: orderedToolCalls } : {}),
    },
    totalTokens,
    finishReason,
    streamed: true,
    chunkCount,
    contentChars: content.length,
    ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
  };
}
