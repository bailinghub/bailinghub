import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio } from './speech';

async function withFetchImplementation<T>(implementation: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const old = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await fn();
  } finally {
    globalThis.fetch = old;
  }
}

function audioResponse(): Response {
  return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });
}

test('transcribeAudio: transcriptions 协议上传音频文件并读取 text', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const got = await withFetchImplementation((async (input, init) => {
    requests.push({ url: String(input), init });
    if (requests.length === 1) return audioResponse();
    return new Response(JSON.stringify({ text: '请查询订单状态' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => transcribeAudio({
    cred: { base_url: 'https://asr.example.com/v1', api_key: 'sk-asr' },
    model: 'whisper-1',
    protocol: 'transcriptions',
    audioUrl: 'https://media.example.com/message.mp3',
  }));

  assert.equal(got.ok, true);
  assert.equal(got.text, '请查询订单状态');
  assert.equal(requests[1]?.url, 'https://asr.example.com/v1/audio/transcriptions');
  assert.equal(requests[1]?.init?.method, 'POST');
  assert.equal(requests[1]?.init?.body instanceof FormData, true);
  const form = requests[1]?.init?.body as FormData;
  assert.equal(form.get('model'), 'whisper-1');
  assert.equal(form.get('file') instanceof Blob, true);
});

test('transcribeAudio: chat_input_audio 协议使用 Data URL 并读取对话文本', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const got = await withFetchImplementation((async (input, init) => {
    requests.push({ url: String(input), init });
    if (requests.length === 1) return audioResponse();
    return new Response(JSON.stringify({
      choices: [{ message: { content: '帮我看一下退款进度' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch, () => transcribeAudio({
    cred: { base_url: 'https://dashscope.example.com/compatible-mode/v1/', api_key: 'sk-asr' },
    model: 'qwen3-asr-flash',
    protocol: 'chat_input_audio',
    audioUrl: 'https://media.example.com/message.mp3',
  }));

  assert.equal(got.ok, true);
  assert.equal(got.text, '帮我看一下退款进度');
  assert.equal(requests[1]?.url, 'https://dashscope.example.com/compatible-mode/v1/chat/completions');
  const body = JSON.parse(String(requests[1]?.init?.body ?? '{}')) as {
    model?: string;
    messages?: Array<{ content?: Array<{ input_audio?: { data?: string } }> }>;
  };
  assert.equal(body.model, 'qwen3-asr-flash');
  assert.match(String(body.messages?.[0]?.content?.[0]?.input_audio?.data), /^data:audio\/mpeg;base64,/);
});
