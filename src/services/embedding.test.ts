import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  dot,
  embedViaApi,
  EmbeddingRequestError,
  normalize,
  type EmbeddingRequestErrorKind,
} from './embedding';

const CREDENTIAL = {
  base_url: 'https://private-embedding.example.invalid/v1',
  api_key: 'api-key-must-not-leak',
};
const RESPONSE_SECRET = 'upstream-body-must-not-leak';

function useFetch(
  t: TestContext,
  stub: (...args: Parameters<typeof fetch>) => Promise<Response>,
): void {
  const original = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function assertApprox(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} should be close to ${expected}`);
}

function assertSafeError(error: unknown, kind: EmbeddingRequestErrorKind): asserts error is EmbeddingRequestError {
  assert.ok(error instanceof EmbeddingRequestError);
  assert.equal(error.kind, kind);
  assert.doesNotMatch(error.message, /private-embedding|api-key-must-not-leak|upstream-body-must-not-leak/);
}

test('embedding transport normalizes vectors and exposes the shared dot product', () => {
  const first = normalize(Float32Array.from([3, 4]));
  const second = normalize(Float32Array.from([4, 3]));
  assertApprox(first[0]!, 0.6);
  assertApprox(first[1]!, 0.8);
  assertApprox(dot(first, second), 0.96);
});

test('embedding transport batches requests, restores response order, and keeps no-timeout calls compatible', async (t) => {
  const inputs: string[][] = [];
  useFetch(t, async (_input, init) => {
    assert.equal(init?.signal, undefined);
    const body = JSON.parse(String(init?.body)) as { input: string[]; dimensions?: number };
    inputs.push(body.input);
    assert.equal(body.dimensions, 4);
    return jsonResponse({
      data: body.input.map((_text, index) => ({ index, embedding: [index + 1, 1, 0, 0] })).reverse(),
    });
  });

  const texts = Array.from({ length: 11 }, (_unused, index) => `text-${index}`);
  const vectors = await embedViaApi(CREDENTIAL, 'embedding-model', 4, texts);

  assert.deepEqual(inputs.map((batch) => batch.length), [10, 1]);
  assert.deepEqual(inputs.flat(), texts);
  assert.equal(vectors.length, texts.length);
  assertApprox(vectors[0]![0]!, Math.SQRT1_2);
  assertApprox(vectors[1]![0]!, 2 / Math.sqrt(5));
});

test('embedding request timeout is reset for every HTTP batch instead of covering a whole rebuild', async (t) => {
  const signals: AbortSignal[] = [];
  useFetch(t, async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    assert.equal(signal.aborted, false);
    signals.push(signal);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, 90);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException('request aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return jsonResponse({ data: body.input.map((_text, index) => ({ index, embedding: [1, 0] })) });
  });

  const startedAt = Date.now();
  const vectors = await embedViaApi(
    CREDENTIAL,
    'embedding-model',
    2,
    Array.from({ length: 11 }, (_unused, index) => `text-${index}`),
    { requestTimeoutMs: 150 },
  );

  assert.equal(vectors.length, 11);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.ok(Date.now() - startedAt >= 150, '总耗时应超过单批截止时间，但两批仍都成功');
});

test('embedding transport aborts a stalled request and returns a sanitized timeout error', async (t) => {
  useFetch(t, async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    return await new Promise<Response>((_resolve, reject) => {
      const onAbort = (): void => reject(new Error(`aborted ${CREDENTIAL.base_url} ${CREDENTIAL.api_key}`));
      signal.addEventListener('abort', onAbort, { once: true });
    });
  });

  await assert.rejects(
    () => embedViaApi(CREDENTIAL, 'embedding-model', 2, ['hello'], { requestTimeoutMs: 20 }),
    (error) => {
      assertSafeError(error, 'timeout');
      assert.equal(error.message, 'embedding request timed out');
      return true;
    },
  );
});

test('embedding transport returns a typed HTTP error without reading or leaking the response body', async (t) => {
  useFetch(t, async () => new Response(RESPONSE_SECRET, { status: 503 }));

  await assert.rejects(
    () => embedViaApi(CREDENTIAL, 'embedding-model', 2, ['hello']),
    (error) => {
      assertSafeError(error, 'http');
      assert.equal(error.status, 503);
      assert.equal(error.message, 'embedding API returned HTTP 503');
      return true;
    },
  );
});

test('embedding transport returns a typed response error when vector count is wrong', async (t) => {
  useFetch(t, async () => jsonResponse({ data: [] }));

  await assert.rejects(
    () => embedViaApi(CREDENTIAL, 'embedding-model', 2, ['hello']),
    (error) => {
      assertSafeError(error, 'response');
      assert.equal(error.message, 'embedding API returned an invalid response');
      return true;
    },
  );
});

test('embedding transport rejects vectors whose length differs from the requested dimension', async (t) => {
  useFetch(t, async () => jsonResponse({ data: [{ index: 0, embedding: [1, 0, 0] }] }));

  await assert.rejects(
    () => embedViaApi(CREDENTIAL, 'embedding-model', 2, ['hello']),
    (error) => {
      assertSafeError(error, 'response');
      assert.equal(error.message, 'embedding API returned an invalid response');
      return true;
    },
  );
});

test('embedding transport sanitizes unexpected network failures', async (t) => {
  useFetch(t, async () => {
    throw new Error(`connect failed: ${CREDENTIAL.base_url} ${CREDENTIAL.api_key} ${RESPONSE_SECRET}`);
  });

  await assert.rejects(
    () => embedViaApi(CREDENTIAL, 'embedding-model', 2, ['hello']),
    (error) => {
      assertSafeError(error, 'network');
      assert.equal(error.message, 'embedding request failed');
      return true;
    },
  );
});
