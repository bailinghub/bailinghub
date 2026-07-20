import test from 'node:test';
import assert from 'node:assert/strict';
import { readOpenAiChatCompletion } from './openai-chat-stream';

function sseResponse(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

test('openai stream: decodes split UTF-8 and aggregates content', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"role":"assistant","content":"你"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  const deltas: string[] = [];
  const result = await readOpenAiChatCompletion(sseResponse([
    bytes.slice(0, 63),
    bytes.slice(63, 66),
    bytes.slice(66),
  ]), { onDelta: (text) => deltas.push(text) });

  assert.equal(result.message['content'], '你好');
  assert.deepEqual(deltas, ['你', '好']);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.streamed, true);
});

test('openai stream: aggregates fragmented tool calls by index', async () => {
  const source = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","type":"function","function":{"name":"order_","arguments":"{\\"id\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"get","arguments":"\\"42\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const result = await readOpenAiChatCompletion(sseResponse([new TextEncoder().encode(source)]));
  const calls = result.message['tool_calls'] as Array<Record<string, unknown>>;

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.['id'], 'call_1');
  assert.deepEqual(calls[0]?.['function'], { name: 'order_get', arguments: '{"id":"42"}' });
});

test('openai stream: accepts a JSON fallback response', async () => {
  const response = new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'fallback' }, finish_reason: 'stop' }],
    usage: { total_tokens: 7 },
  }), { headers: { 'content-type': 'application/json' } });
  const result = await readOpenAiChatCompletion(response);
  assert.equal(result.message['content'], 'fallback');
  assert.equal(result.totalTokens, 7);
  assert.equal(result.streamed, false);
});

test('openai stream: rejects a truncated response without completion evidence', async () => {
  const response = sseResponse([new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')]);
  await assert.rejects(() => readOpenAiChatCompletion(response), /提前结束/);
});
