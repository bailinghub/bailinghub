import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { readResponseBody, ResponseBodyLimitError, truncateUtf8 } from './http-body';

function response(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let pulls = 0;
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulls++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { cancels++; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers }), body, counts: () => ({ pulls, cancels }) };
}

async function withLoopbackServer(handler: (response: ServerResponse) => void, check: (url: string) => Promise<void>) {
  const server = createServer((_req, res) => handler(res));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await check(`http://127.0.0.1:${address.port}/synthetic`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('bounded response: exact limit preserves bytes and releases the reader', async () => {
  const fx = response([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
  assert.deepEqual(new Uint8Array(await readResponseBody(fx.response, 4)), new Uint8Array([1, 2, 3, 4]));
  assert.equal(fx.body.locked, false);
  assert.equal(fx.counts().cancels, 0);
});

test('bounded response: stream over limit cancels before consuming later chunks', async () => {
  const fx = response([new Uint8Array(4), new Uint8Array(1), new Uint8Array(100)]);
  await assert.rejects(readResponseBody(fx.response, 4), (error: unknown) => {
    assert.ok(error instanceof ResponseBodyLimitError);
    assert.equal(error.source, 'stream');
    assert.equal(error.observedBytes, 5);
    return true;
  });
  assert.deepEqual(fx.counts(), { pulls: 2, cancels: 1 });
  assert.equal(fx.body.locked, false);
});

test('bounded response: excessive declared length cancels without reading', async () => {
  const fx = response([new Uint8Array(4)], { 'content-length': '5' });
  await assert.rejects(readResponseBody(fx.response, 4), (error: unknown) => {
    assert.ok(error instanceof ResponseBodyLimitError);
    assert.equal(error.source, 'content-length');
    return true;
  });
  assert.deepEqual(fx.counts(), { pulls: 0, cancels: 1 });
});

test('bounded response: low encoded length cannot bypass decoded stream budget', async () => {
  const fx = response([new Uint8Array(5)], { 'content-length': '1', 'content-encoding': 'gzip' });
  await assert.rejects(readResponseBody(fx.response, 4), ResponseBodyLimitError);
  assert.equal(fx.counts().cancels, 1);
});

test('bounded response: native fetch gzip decoding cannot bypass the byte budget', async () => {
  const encoded = gzipSync('a'.repeat(2048));
  assert.ok(encoded.byteLength < 1024);
  await withLoopbackServer((r) => {
    r.writeHead(200, { 'content-encoding': 'gzip', 'content-length': encoded.byteLength });
    r.end(encoded);
  }, async (url) => {
    const r = await fetch(url);
    await assert.rejects(readResponseBody(r, 1024), (error: unknown) => {
      assert.ok(error instanceof ResponseBodyLimitError);
      assert.equal(error.source, 'stream');
      assert.ok(error.observedBytes > 1024);
      return true;
    });
    assert.equal(r.body!.locked, false);
  });
});

test('bounded response: native fetch abort after headers rejects partial body', async () => {
  await withLoopbackServer((r) => { r.writeHead(200); r.write('a'); }, async (url) => {
    const abort = new AbortController();
    const r = await fetch(url, { signal: abort.signal });
    const pending = readResponseBody(r, 1024);
    abort.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    assert.equal(r.body!.locked, false);
  });
});

test('bounded response: invalid length is ignored while the stream remains limited', async () => {
  for (const length of ['garbage', '-1', '2.5']) {
    const fx = response([new Uint8Array(5)], { 'content-length': length });
    await assert.rejects(readResponseBody(fx.response, 4), ResponseBodyLimitError);
    assert.equal(fx.counts().cancels, 1);
  }
});

test('bounded response: enormous declared lengths also fail closed', async () => {
  const fx = response([], { 'content-length': '9'.repeat(400) });
  await assert.rejects(readResponseBody(fx.response, 4), ResponseBodyLimitError);
  assert.equal(fx.counts().pulls, 0);
});

test('bounded response: empty body and zero budget are supported', async () => {
  assert.equal((await readResponseBody(new Response(null), 0)).byteLength, 0);
});

test('bounded response: invalid budget rejects before response consumption', async () => {
  const fx = response([new Uint8Array(5)]);
  await assert.rejects(readResponseBody(fx.response, Infinity), RangeError);
  assert.equal(fx.counts().pulls, 0);
});

test('bounded response: original error survives rejected/pending cancellation and releases reader', { timeout: 1000 }, async () => {
  for (const pending of [false, true]) {
    const original = new DOMException('synthetic body timeout', 'TimeoutError');
    let cancels = 0;
    let releases = 0;
    const fake = { headers: new Headers(), body: { getReader: () => ({
      read: async () => { throw original; },
      cancel: async () => {
        cancels++;
        if (pending) await new Promise<void>(() => undefined);
        else throw new Error('synthetic cancellation failure');
      },
      releaseLock: () => { releases++; },
    }) } } as unknown as Response;
    await assert.rejects(readResponseBody(fake, 4), (error: unknown) => error === original);
    assert.equal(cancels, 1);
    assert.equal(releases, 1);
  }
});

test('bounded response: pending cancel cannot hold a limit error or reader lock open', { timeout: 1000 }, async () => {
  for (const declared of [false, true]) {
    let cancels = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(5)); },
      cancel() { cancels++; return new Promise<void>(() => undefined); },
    }, { highWaterMark: 0 });
    const r = new Response(body, { headers: declared ? { 'content-length': '5' } : {} });
    await assert.rejects(readResponseBody(r, 4), ResponseBodyLimitError);
    assert.equal(cancels, 1);
    assert.equal(body.locked, false);
  }
});

test('bounded response: fetch body abort is propagated without partial success', async () => {
  const controller = new AbortController();
  const failure = new DOMException('synthetic timeout', 'TimeoutError');
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new Uint8Array([1]));
      controller.signal.addEventListener('abort', () => stream.error(controller.signal.reason), { once: true });
    },
  });
  const pending = readResponseBody(new Response(body), 4);
  controller.abort(failure);
  await assert.rejects(pending, (error: unknown) => error === failure);
  assert.equal(body.locked, false);
});

test('bounded response: Unicode split between chunks remains intact', async () => {
  const bytes = new TextEncoder().encode('汉🙂');
  const fx = response([bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)]);
  assert.equal(new TextDecoder().decode(await readResponseBody(fx.response, 7)), '汉🙂');
});

test('UTF-8 view budget: no split characters, replacement suffix, or excess bytes', () => {
  for (let limit = 0; limit <= 9; limit++) {
    const got = truncateUtf8('a汉🙂z', limit);
    assert.ok(Buffer.byteLength(got) <= limit);
    assert.equal(got.includes('\ufffd'), false);
  }
  assert.equal(truncateUtf8('汉🙂', 6), '汉');
  assert.equal(truncateUtf8('汉🙂', 7), '汉🙂');
});
