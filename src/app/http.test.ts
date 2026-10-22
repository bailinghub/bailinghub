import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PayloadTooLargeError, readBody, readRawBody } from './http';

function req(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

test('readBody: 默认 JSON 读取支持显式上限并在超限时拒绝', async () => {
  await assert.rejects(
    () => readBody(req(JSON.stringify({ text: 'abcdef' })), 8),
    (e) => e instanceof PayloadTooLargeError && e.statusCode === 413 && e.maxBytes === 8 && e.observedBytes === 17,
  );
});

test('readBody: stream overflow reports observed UTF-8 bytes and stops before reading the remainder', async () => {
  let chunksRead = 0;
  async function* chunks() {
    for (const text of ['{"value":"', '中文😀', 'private-unread-remainder"}']) {
      chunksRead++;
      yield Buffer.from(text, 'utf8');
    }
  }
  await assert.rejects(
    () => readBody(chunks() as unknown as IncomingMessage, 16),
    (e) => e instanceof PayloadTooLargeError && e.maxBytes === 16 && e.observedBytes === 20,
  );
  assert.equal(chunksRead, 2);
});

test('readBody: 限内 JSON 正常解析', async () => {
  assert.deepEqual(await readBody(req(JSON.stringify({ ok: true })), 64), { ok: true });
});

test('readRawBody: XML/原始请求同样执行大小上限', async () => {
  await assert.rejects(
    () => readRawBody(req('<xml>too-large</xml>'), 4),
    (e) => e instanceof PayloadTooLargeError && e.statusCode === 413,
  );
});
