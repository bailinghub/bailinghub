import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCredentialConnection } from './credential-verify';

const credential = {
  base_url: 'https://llm.example.com/v1',
  api_key: 'sk-test',
  default_model: 'model-a',
};

function mockFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {})) as typeof fetch;
}

test('verifyCredentialConnection: chat 走 chat/completions 并返回可达', async () => {
  const got = await verifyCredentialConnection({ credential, capability: 'chat' }, mockFetch((url, init) => {
    assert.equal(url, 'https://llm.example.com/v1/chat/completions');
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer sk-test');
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, 'model-a');
    assert.equal(body.messages[0].content, 'Reply with exactly OK.');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
  }));

  assert.equal(got.ok, true);
  assert.equal(got.capability, 'chat');
  assert.equal(got.model, 'model-a');
  assert.equal(got.endpoint, '/chat/completions');
  assert.match(got.message, /OK/);
});

test('verifyCredentialConnection: vision 发送 image_url 多模态请求', async () => {
  const got = await verifyCredentialConnection({ credential, capability: 'vision', model: 'vl-model' }, mockFetch((_url, init) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, 'vl-model');
    assert.equal(body.messages[0].content[1].type, 'image_url');
    assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK.' } }] }), { status: 200 });
  }));

  assert.equal(got.ok, true);
  assert.equal(got.capability, 'vision');
});

test('verifyCredentialConnection: embedding 走 embeddings 并报告维度', async () => {
  const got = await verifyCredentialConnection({ credential, capability: 'embedding', model: 'embed-model' }, mockFetch((url, init) => {
    assert.equal(url, 'https://llm.example.com/v1/embeddings');
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, 'embed-model');
    assert.equal(body.input, 'bailing credential health check');
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
  }));

  assert.equal(got.ok, true);
  assert.equal(got.message, '向量接口可达，维度 3');
});

test('verifyCredentialConnection: HTTP 错误提取平台 error code/message', async () => {
  const got = await verifyCredentialConnection({ credential, capability: 'vision', model: 'bad-vl' }, mockFetch(() => new Response(JSON.stringify({
    error: { code: 'access_denied', message: 'Access denied' },
  }), { status: 403 })));

  assert.equal(got.ok, false);
  assert.equal(got.status, 403);
  assert.equal(got.message, 'HTTP 403: access_denied: Access denied');
});
