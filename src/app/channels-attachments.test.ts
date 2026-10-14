import test from 'node:test';
import assert from 'node:assert/strict';
import { channelSendFor } from './channels';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

const config = { channels: { get: async () => ({ kind: 'wecom', enabled: true,
  config: { corpid: 'synthetic', secret: 'synthetic', agentid: '1' } }) } } as unknown as ConfigStoreContract;

test('channel attachments: oversized declared bodies cancel before upload or message dispatch', async (t) => {
  let pulls = 0;
  let cancels = 0;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    assert.equal(String(input), 'https://synthetic.invalid/a.txt');
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(1)); },
      cancel() { cancels++; },
    }, { highWaterMark: 0 }), { headers: { 'content-length': String(20 * 1024 * 1024 + 1) } });
  });
  const result = await channelSendFor(config, 'synthetic', 'recipient', { text: 'synthetic', files: [{ url: 'https://synthetic.invalid/a.txt' }] });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /超过 20MB 上限/);
  assert.equal(result.mayHaveCommitted, undefined);
  assert.equal(calls, 1);
  assert.equal(pulls, 0);
  assert.equal(cancels, 1);
});

test('channel attachments: low declared length cannot bypass body limit or upload partial media', async (t) => {
  let pulls = 0;
  let cancels = 0;
  let calls = 0;
  const chunk = new Uint8Array(1024 * 1024);
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    assert.equal(String(input), 'https://synthetic.invalid/a.png');
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(pulls <= 20 ? chunk : new Uint8Array(1)); },
      cancel() { cancels++; },
    }, { highWaterMark: 0 }), { headers: { 'content-length': '1' } });
  });
  const result = await channelSendFor(config, 'synthetic', 'recipient', { images: ['https://synthetic.invalid/a.png'] });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /超过 20MB 上限/);
  assert.equal(calls, 1);
  assert.equal(pulls, 21);
  assert.equal(cancels, 1);
});

test('channel attachments: HTTP errors cancel promptly and keep original status', async (t) => {
  let pulls = 0;
  let cancels = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1)); },
    cancel() { cancels++; return new Promise<void>(() => undefined); },
  }, { highWaterMark: 0 }), { status: 403 }));
  const result = await channelSendFor(config, 'synthetic', 'recipient', { files: [{ url: 'https://synthetic.invalid/a.txt' }] });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /HTTP 403/);
  assert.equal(pulls, 0);
  assert.equal(cancels, 1);
});
