import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { ToolProvider } from '../core/contracts/types';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type {
  ToolEmbeddingRepository,
  ToolEmbeddingVectorQuery,
  ToolEmbeddingVectorRow,
} from './tool-index-repository';
import {
  ToolIndexService,
  ToolRetrievalError,
  type ToolEmbedConfig,
  type ToolRetrievalObservation,
} from './tools-index';

const EMBED_CONFIG: ToolEmbedConfig = {
  credential: 'embed-main',
  model: 'embedding-model-v1',
  dim: 2,
};
const CREDENTIAL = {
  name: 'embed-main',
  kind: 'embedding' as const,
  base_url: 'https://private-embedding.example.invalid/v1',
  api_key: 'api-key-must-not-leak',
  enabled: true,
};
const USER_QUERY = 'user-query-must-not-leak';

function appConfig(input: { indexLoadTimeoutMs?: number; embeddingTimeoutMs?: number } = {}): AppConfig {
  return {
    toolRetrieval: {
      indexLoadTimeoutMs: input.indexLoadTimeoutMs ?? 100,
      embeddingTimeoutMs: input.embeddingTimeoutMs ?? 100,
    },
    llmCredentials: {},
  } as unknown as AppConfig;
}

function configStore(onGet?: (name: string) => void): ConfigStoreContract {
  return {
    credentials: {
      async get(name: string) {
        onGet?.(name);
        return name === CREDENTIAL.name ? CREDENTIAL : null;
      },
      async touch() { /* observation-only field */ },
    },
  } as unknown as ConfigStoreContract;
}

function repository(
  listVectors: (provider: string, query: ToolEmbeddingVectorQuery) => Promise<ToolEmbeddingVectorRow[]>,
): ToolEmbeddingRepository {
  return {
    async listSnapshot() { return []; },
    async deleteProvider() { /* test double */ },
    async upsert() { /* test double */ },
    async deleteTools() { /* test double */ },
    listVectors,
  };
}

function vectorBuffer(values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function vectorRow(name: string, values: number[], scope = 'order.read'): ToolEmbeddingVectorRow {
  return {
    tool_name: name,
    scope,
    embedding: vectorBuffer(values),
    model: EMBED_CONFIG.model,
    dim: EMBED_CONFIG.dim,
  };
}

function embeddingResponse(values: number[]): Response {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: values }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function indexedProvider(): ToolProvider {
  return {
    name: 'orders',
    enabled: true,
    base_url: 'https://orders.example.invalid',
    secret: 'secret',
    spec_source: 'inline',
    spec_json: JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'orders', version: '1' },
      paths: {
        '/orders': {
          get: {
            operationId: 'order_list',
            summary: '查询订单',
            'x-agent-capability': { version: 1, enabled: true, scope: 'order.read' },
          },
        },
      },
    }),
    log_payload: false,
    timeout_ms: 10_000,
    rate_limit_per_min: 60,
  } as ToolProvider;
}

function useFetch(
  t: TestContext,
  stub: (...args: Parameters<typeof fetch>) => Promise<Response>,
): void {
  const original = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function assertRetrievalError(reason: ToolRetrievalError['reason']): (error: unknown) => true {
  return (error: unknown) => {
    assert.ok(error instanceof ToolRetrievalError);
    assert.equal(error.reason, reason);
    return true;
  };
}

test('tool index retrieves ranked hits, reports one sanitized observation, and reuses a fresh cache', async (t) => {
  const queries: Array<{ provider: string; query: ToolEmbeddingVectorQuery }> = [];
  let credentialGets = 0;
  let fetchCalls = 0;
  const observations: ToolRetrievalObservation[] = [];
  const service = new ToolIndexService(
    configStore(() => { credentialGets++; }),
    appConfig({ indexLoadTimeoutMs: 321, embeddingTimeoutMs: 654 }),
    repository(async (provider, query) => {
      queries.push({ provider, query });
      return [vectorRow('order_list', [1, 0]), vectorRow('shipment_list', [0, 1], 'shipment.read')];
    }),
  );
  useFetch(t, async (_input, init) => {
    fetchCalls++;
    const body = JSON.parse(String(init?.body)) as { model: string; dimensions: number; input: string[] };
    assert.equal(body.model, EMBED_CONFIG.model);
    assert.equal(body.dimensions, EMBED_CONFIG.dim);
    assert.deepEqual(body.input, [USER_QUERY]);
    assert.ok(init?.signal);
    return embeddingResponse([4, 1]);
  });

  const first = await service.retrieve(
    'orders',
    new Set(['order_list', 'shipment_list']),
    USER_QUERY,
    EMBED_CONFIG,
    { minScore: 0, maxTools: 2, observe: (observation) => { observations.push(observation); } },
  );
  const second = await service.retrieve(
    'orders',
    new Set(['order_list', 'shipment_list']),
    USER_QUERY,
    EMBED_CONFIG,
    { minScore: 0, maxTools: 1, observe: (observation) => { observations.push(observation); } },
  );

  assert.deepEqual(first?.map((hit) => hit.name), ['order_list', 'shipment_list']);
  assert.deepEqual(second?.map((hit) => hit.name), ['order_list']);
  assert.deepEqual(queries, [{
    provider: 'orders',
    query: { model: EMBED_CONFIG.model, dim: EMBED_CONFIG.dim, timeoutMs: 321 },
  }]);
  assert.equal(credentialGets, 2);
  assert.equal(fetchCalls, 2);
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map((item) => item.cache_state), ['miss', 'fresh']);
  assert.deepEqual(observations.map((item) => item.status), ['ok', 'ok']);
  assert.deepEqual(observations.map((item) => item.picked), [2, 1]);
  const serialized = JSON.stringify(observations);
  assert.doesNotMatch(serialized, /user-query-must-not-leak|private-embedding|api-key-must-not-leak/);
});

test('a cold index timeout is classified once and never reaches credential resolution or fetch', async (t) => {
  let credentialGets = 0;
  let fetchCalls = 0;
  const queries: ToolEmbeddingVectorQuery[] = [];
  const observations: ToolRetrievalObservation[] = [];
  const service = new ToolIndexService(
    configStore(() => { credentialGets++; }),
    appConfig({ indexLoadTimeoutMs: 20 }),
    repository(async (_provider, query) => {
      queries.push(query);
      return await new Promise<ToolEmbeddingVectorRow[]>(() => undefined);
    }),
  );
  useFetch(t, async () => {
    fetchCalls++;
    return embeddingResponse([1, 0]);
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => service.retrieve('orders', new Set(['order_list']), USER_QUERY, EMBED_CONFIG, {
      minScore: 0,
      maxTools: 1,
      observe: (observation) => { observations.push(observation); },
    }),
    assertRetrievalError('index_load_timeout'),
  );

  assert.ok(Date.now() - startedAt < 500, 'cold index wait should remain bounded');
  assert.deepEqual(queries, [{ model: EMBED_CONFIG.model, dim: EMBED_CONFIG.dim, timeoutMs: 20 }]);
  assert.equal(credentialGets, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.status, 'degraded');
  assert.equal(observations[0]?.reason, 'index_load_timeout');
});

test('concurrent cold retrievals share one in-flight index load', async (t) => {
  const pendingRows = deferred<ToolEmbeddingVectorRow[]>();
  let listCalls = 0;
  let fetchCalls = 0;
  const service = new ToolIndexService(
    configStore(),
    appConfig(),
    repository(async () => {
      listCalls++;
      return await pendingRows.promise;
    }),
  );
  useFetch(t, async () => {
    fetchCalls++;
    return embeddingResponse([1, 0]);
  });

  const first = service.retrieve('orders', new Set(['order_list']), 'first query', EMBED_CONFIG, { minScore: 0, maxTools: 1 });
  const second = service.retrieve('orders', new Set(['order_list']), 'second query', EMBED_CONFIG, { minScore: 0, maxTools: 1 });
  assert.equal(listCalls, 1);
  pendingRows.resolve([vectorRow('order_list', [1, 0])]);

  const [firstHits, secondHits] = await Promise.all([first, second]);
  assert.deepEqual(firstHits?.map((hit) => hit.name), ['order_list']);
  assert.deepEqual(secondHits?.map((hit) => hit.name), ['order_list']);
  assert.equal(listCalls, 1);
  assert.equal(fetchCalls, 2);
});

test('repository rejection is classified as a sanitized index error and observed once', async (t) => {
  let credentialGets = 0;
  let fetchCalls = 0;
  const observations: ToolRetrievalObservation[] = [];
  const service = new ToolIndexService(
    configStore(() => { credentialGets++; }),
    appConfig(),
    repository(async () => { throw new Error('db password=must-not-leak'); }),
  );
  useFetch(t, async () => {
    fetchCalls++;
    return embeddingResponse([1, 0]);
  });

  await assert.rejects(
    () => service.retrieve('orders', new Set(['order_list']), USER_QUERY, EMBED_CONFIG, {
      minScore: 0,
      maxTools: 1,
      observe: (observation) => { observations.push(observation); },
    }),
    (error) => {
      assertRetrievalError('index_load_error')(error);
      assert.doesNotMatch((error as Error).message, /password|must-not-leak/);
      return true;
    },
  );

  assert.equal(credentialGets, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.reason, 'index_load_error');
  assert.doesNotMatch(JSON.stringify(observations), /user-query-must-not-leak|password|must-not-leak/);
});

test('a stalled embedding request is aborted and classified as embedding_timeout', async (t) => {
  let aborted = false;
  const observations: ToolRetrievalObservation[] = [];
  const service = new ToolIndexService(
    configStore(),
    appConfig({ embeddingTimeoutMs: 20 }),
    repository(async () => [vectorRow('order_list', [1, 0])]),
  );
  useFetch(t, async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    return await new Promise<Response>((_resolve, reject) => {
      const onAbort = (): void => {
        aborted = true;
        reject(new DOMException('request aborted', 'AbortError'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  });

  await assert.rejects(
    () => service.retrieve('orders', new Set(['order_list']), USER_QUERY, EMBED_CONFIG, {
      minScore: 0,
      maxTools: 1,
      observe: (observation) => { observations.push(observation); },
    }),
    assertRetrievalError('embedding_timeout'),
  );

  assert.equal(aborted, true);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.reason, 'embedding_timeout');
});

test('embedding HTTP failure is classified as embedding_error', async (t) => {
  const observations: ToolRetrievalObservation[] = [];
  const service = new ToolIndexService(
    configStore(),
    appConfig(),
    repository(async () => [vectorRow('order_list', [1, 0])]),
  );
  useFetch(t, async () => new Response('upstream-body-must-not-leak', { status: 503 }));

  await assert.rejects(
    () => service.retrieve('orders', new Set(['order_list']), USER_QUERY, EMBED_CONFIG, {
      minScore: 0,
      maxTools: 1,
      observe: (observation) => { observations.push(observation); },
    }),
    assertRetrievalError('embedding_error'),
  );

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.reason, 'embedding_error');
  assert.doesNotMatch(JSON.stringify(observations), /upstream-body|user-query-must-not-leak|private-embedding|api-key/);
});

test('invalid embedding response is classified as embedding_error', async (t) => {
  const observations: ToolRetrievalObservation[] = [];
  const service = new ToolIndexService(
    configStore(),
    appConfig(),
    repository(async () => [vectorRow('order_list', [1, 0])]),
  );
  useFetch(t, async () => new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));

  await assert.rejects(
    () => service.retrieve('orders', new Set(['order_list']), USER_QUERY, EMBED_CONFIG, {
      minScore: 0,
      maxTools: 1,
      observe: (observation) => { observations.push(observation); },
    }),
    assertRetrievalError('embedding_error'),
  );

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.reason, 'embedding_error');
});

test('observation callback failures never block a successful retrieval', async (t) => {
  const service = new ToolIndexService(
    configStore(),
    appConfig(),
    repository(async () => [vectorRow('order_list', [1, 0])]),
  );
  useFetch(t, async () => embeddingResponse([1, 0]));

  const syncFailure = await service.retrieve('orders', new Set(['order_list']), 'sync observer', EMBED_CONFIG, {
    minScore: 0,
    maxTools: 1,
    observe: () => { throw new Error('sync observer failed'); },
  });
  const asyncFailure = await service.retrieve('orders', new Set(['order_list']), 'async observer', EMBED_CONFIG, {
    minScore: 0,
    maxTools: 1,
    observe: async () => { throw new Error('async observer failed'); },
  });

  assert.deepEqual(syncFailure?.map((hit) => hit.name), ['order_list']);
  assert.deepEqual(asyncFailure?.map((hit) => hit.name), ['order_list']);
});

test('a hanging observation sink never delays retrieval completion', async (t) => {
  const service = new ToolIndexService(
    configStore(),
    appConfig(),
    repository(async () => [vectorRow('order_list', [1, 0])]),
  );
  useFetch(t, async () => embeddingResponse([1, 0]));

  const hits = await Promise.race([
    service.retrieve('orders', new Set(['order_list']), USER_QUERY, EMBED_CONFIG, {
      minScore: 0,
      maxTools: 1,
      observe: async () => await new Promise<void>(() => undefined),
    }),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('observation blocked retrieval')), 100)),
  ]);

  assert.deepEqual(hits?.map((hit) => hit.name), ['order_list']);
});

test('a stalled credential lookup is bounded before query embedding starts', async (t) => {
  let fetchCalls = 0;
  const observations: ToolRetrievalObservation[] = [];
  const store = {
    credentials: {
      async get() { return await new Promise<never>(() => undefined); },
      async touch() { /* observation-only field */ },
    },
  } as unknown as ConfigStoreContract;
  const service = new ToolIndexService(
    store,
    appConfig({ indexLoadTimeoutMs: 20 }),
    repository(async () => [vectorRow('order_list', [1, 0])]),
  );
  useFetch(t, async () => {
    fetchCalls++;
    return embeddingResponse([1, 0]);
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => service.retrieve('orders', new Set(['order_list']), USER_QUERY, EMBED_CONFIG, {
      minScore: 0,
      maxTools: 1,
      observe: (observation) => { observations.push(observation); },
    }),
    assertRetrievalError('credential_timeout'),
  );

  assert.ok(Date.now() - startedAt < 500, 'credential lookup wait should remain bounded');
  assert.equal(fetchCalls, 0);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.reason, 'credential_timeout');
});

test('stale cache serves immediately while one background refresh replaces it', async (t) => {
  const refreshRows = deferred<ToolEmbeddingVectorRow[]>();
  const observations: ToolRetrievalObservation[] = [];
  const queries: ToolEmbeddingVectorQuery[] = [];
  let listCalls = 0;
  let fetchCalls = 0;
  const service = new ToolIndexService(
    configStore(),
    appConfig({ indexLoadTimeoutMs: 400 }),
    repository(async (_provider, query) => {
      queries.push(query);
      listCalls++;
      if (listCalls === 1) return [vectorRow('old_tool', [1, 0])];
      return await refreshRows.promise;
    }),
  );
  useFetch(t, async () => {
    fetchCalls++;
    return embeddingResponse(fetchCalls <= 2 ? [1, 0] : [0, 1]);
  });

  const first = await service.retrieve('orders', new Set(['old_tool', 'new_tool']), 'prime cache', EMBED_CONFIG, {
    minScore: 0,
    maxTools: 1,
  });
  assert.deepEqual(first?.map((hit) => hit.name), ['old_tool']);

  const cache = (service as unknown as { cache: Map<string, { at: number; rows: unknown[] }> }).cache;
  assert.equal(cache.size, 1);
  for (const entry of cache.values()) entry.at = Date.now() - 11 * 60_000;

  const staleResult = service.retrieve('orders', new Set(['old_tool', 'new_tool']), 'serve stale', EMBED_CONFIG, {
    minScore: 0,
    maxTools: 1,
    observe: (observation) => { observations.push(observation); },
  });
  let staleDeadline: NodeJS.Timeout | undefined;
  const stale = await Promise.race([
    staleResult,
    new Promise<never>((_resolve, reject) => {
      staleDeadline = setTimeout(() => reject(new Error('stale cache blocked on refresh')), 250);
    }),
  ]).finally(() => { if (staleDeadline) clearTimeout(staleDeadline); });
  assert.deepEqual(stale?.map((hit) => hit.name), ['old_tool']);
  assert.equal(listCalls, 2);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.cache_state, 'stale');

  refreshRows.resolve([vectorRow('new_tool', [0, 1])]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const fresh = await service.retrieve('orders', new Set(['old_tool', 'new_tool']), 'use refresh', EMBED_CONFIG, {
    minScore: 0,
    maxTools: 1,
    observe: (observation) => { observations.push(observation); },
  });
  assert.deepEqual(fresh?.map((hit) => hit.name), ['new_tool']);
  assert.equal(listCalls, 2);
  assert.equal(observations[1]?.cache_state, 'fresh');
  assert.deepEqual(queries, [
    { model: EMBED_CONFIG.model, dim: EMBED_CONFIG.dim, timeoutMs: 400 },
    { model: EMBED_CONFIG.model, dim: EMBED_CONFIG.dim, timeoutMs: 400 },
  ]);
});

test('invalidate prevents an older background refresh from repopulating the cache', async (t) => {
  const oldRefresh = deferred<ToolEmbeddingVectorRow[]>();
  let listCalls = 0;
  const service = new ToolIndexService(
    configStore(),
    appConfig({ indexLoadTimeoutMs: 400 }),
    repository(async () => {
      listCalls++;
      if (listCalls === 1) return [vectorRow('old_tool', [1, 0])];
      if (listCalls === 2) return await oldRefresh.promise;
      return [vectorRow('new_tool', [1, 0])];
    }),
  );
  useFetch(t, async () => embeddingResponse([1, 0]));
  const allowed = new Set(['old_tool', 'new_tool']);

  assert.deepEqual((await service.retrieve('orders', allowed, 'prime', EMBED_CONFIG, { minScore: 0, maxTools: 1 }))?.map((hit) => hit.name), ['old_tool']);
  const cache = (service as unknown as { cache: Map<string, { at: number; rows: unknown[] }> }).cache;
  for (const entry of cache.values()) entry.at = Date.now() - 11 * 60_000;
  assert.deepEqual((await service.retrieve('orders', allowed, 'stale', EMBED_CONFIG, { minScore: 0, maxTools: 1 }))?.map((hit) => hit.name), ['old_tool']);
  assert.equal(listCalls, 2);

  service.invalidate('orders');
  assert.deepEqual((await service.retrieve('orders', allowed, 'after reindex', EMBED_CONFIG, { minScore: 0, maxTools: 1 }))?.map((hit) => hit.name), ['new_tool']);
  assert.equal(listCalls, 3);
  oldRefresh.resolve([vectorRow('late_old_tool', [1, 0])]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const final = await service.retrieve('orders', new Set(['new_tool', 'late_old_tool']), 'final', EMBED_CONFIG, { minScore: 0, maxTools: 1 });
  assert.deepEqual(final?.map((hit) => hit.name), ['new_tool']);
  assert.equal(listCalls, 3);
});

test('prewarm loads stored vectors only and the first retrieval reuses the fresh cache', async (t) => {
  let listCalls = 0;
  let credentialGets = 0;
  let fetchCalls = 0;
  const observations: ToolRetrievalObservation[] = [];
  const service = new ToolIndexService(
    configStore(() => { credentialGets++; }),
    appConfig(),
    repository(async () => {
      listCalls++;
      return [vectorRow('order_list', [1, 0])];
    }),
  );
  useFetch(t, async () => {
    fetchCalls++;
    return embeddingResponse([1, 0]);
  });

  assert.equal(await service.prewarmProvider('orders', EMBED_CONFIG), 1);
  assert.equal(listCalls, 1);
  assert.equal(credentialGets, 0, 'prewarm must not resolve the embedding credential');
  assert.equal(fetchCalls, 0, 'prewarm must not call the embedding API');

  const hits = await service.retrieve('orders', new Set(['order_list']), USER_QUERY, EMBED_CONFIG, {
    minScore: 0,
    maxTools: 1,
    observe: (observation) => { observations.push(observation); },
  });
  assert.deepEqual(hits?.map((hit) => hit.name), ['order_list']);
  assert.equal(listCalls, 1, 'first retrieval should reuse the prewarmed in-memory index');
  assert.equal(credentialGets, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(observations[0]?.cache_state, 'fresh');
});

test('legacy repositories without row-level coordinates degrade without consulting a mutable snapshot', async (t) => {
  let snapshotCalls = 0;
  let fetchCalls = 0;
  const observations: ToolRetrievalObservation[] = [];
  const repo: ToolEmbeddingRepository = {
    async listSnapshot(_provider, query) {
      snapshotCalls++;
      assert.equal(query?.timeoutMs, 100);
      return [{ tool_name: 'order_list', text_hash: 'new-hash', model: EMBED_CONFIG.model, dim: EMBED_CONFIG.dim }];
    },
    async deleteProvider() { /* legacy adapter */ },
    async upsert() { /* legacy adapter */ },
    async deleteTools() { /* legacy adapter */ },
    async listVectors() {
      return [{ tool_name: 'order_list', scope: 'order.read', embedding: vectorBuffer([1, 0]) }];
    },
  };
  const service = new ToolIndexService(configStore(), appConfig(), repo);
  useFetch(t, async () => {
    fetchCalls++;
    return embeddingResponse([1, 0]);
  });

  const hits = await service.retrieve('orders', new Set(['order_list']), USER_QUERY, EMBED_CONFIG, {
    minScore: 0,
    maxTools: 1,
    observe: (observation) => { observations.push(observation); },
  });

  assert.equal(hits, null);
  assert.equal(snapshotCalls, 0, 'a second mutable read cannot prove the coordinates of legacy vector rows');
  assert.equal(fetchCalls, 0, 'missing row-level coordinates must fail before query embedding');
  assert.equal(observations[0]?.reason, 'index_empty');
});

test('same-provider rebuilds serialize the full snapshot-to-persist critical section', async (t) => {
  const firstPersist = deferred<void>();
  let credentialGets = 0;
  let snapshots = 0;
  let upserts = 0;
  let active = 0;
  let maxActive = 0;
  const repo: ToolEmbeddingRepository = {
    async listSnapshot() {
      snapshots++;
      active++;
      maxActive = Math.max(maxActive, active);
      return [];
    },
    async deleteProvider() { /* test double */ },
    async upsert() {
      upserts++;
      if (upserts === 1) await firstPersist.promise;
      active--;
    },
    async deleteTools() { /* test double */ },
    async listVectors() { return []; },
  };
  const service = new ToolIndexService(configStore(() => { credentialGets++; }), appConfig(), repo);
  useFetch(t, async () => embeddingResponse([1, 0]));

  const first = service.reindexProvider(indexedProvider(), EMBED_CONFIG);
  const second = service.reindexProvider(indexedProvider(), EMBED_CONFIG);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(credentialGets, 1, 'second rebuild must not resolve credentials before the first persists');
  assert.equal(snapshots, 1, 'second rebuild must not read a snapshot before the first persists');
  assert.equal(upserts, 1);
  assert.equal(maxActive, 1);

  firstPersist.resolve();
  await Promise.all([first, second]);
  assert.equal(credentialGets, 2);
  assert.equal(snapshots, 2);
  assert.equal(upserts, 2);
  assert.equal(maxActive, 1, 'same-provider rebuild critical sections must never overlap');
});

test('a queued rebuild rereads the authoritative provider and never writes a stale spec or coordinate', async (t) => {
  const latest = {
    ...indexedProvider(),
    spec_json: JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'orders', version: '2' },
      paths: {
        '/orders/latest': {
          get: {
            operationId: 'order_list_latest',
            summary: '查询最新订单',
            'x-agent-capability': { version: 1, enabled: true, scope: 'order.read' },
          },
        },
      },
    }),
    embed_credential: EMBED_CONFIG.credential,
    embed_model: 'embedding-model-v2',
    embed_dim: 3,
  } satisfies ToolProvider;
  const written: Array<{ tool_name: string; model: string; dim: number }> = [];
  const store = {
    toolProviders: { async get() { return latest; } },
    credentials: {
      async get() { return CREDENTIAL; },
      async touch() { /* observation-only field */ },
    },
  } as unknown as ConfigStoreContract;
  const repo: ToolEmbeddingRepository = {
    async listSnapshot() { return []; },
    async deleteProvider() { /* test double */ },
    async upsert(row) { written.push({ tool_name: row.tool_name, model: row.model, dim: row.dim }); },
    async deleteTools() { /* test double */ },
    async listVectors() { return []; },
  };
  const service = new ToolIndexService(store, appConfig(), repo);
  useFetch(t, async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; dimensions: number };
    assert.equal(body.model, 'embedding-model-v2');
    assert.equal(body.dimensions, 3);
    return embeddingResponse([1, 0, 0]);
  });

  await service.reindexProvider(indexedProvider(), EMBED_CONFIG);
  assert.deepEqual(written, [{ tool_name: 'order_list_latest', model: 'embedding-model-v2', dim: 3 }]);
});

test('coordinate migration keeps the previous persisted index when embedding fails before cutover', async (t) => {
  let deletes = 0;
  let upserts = 0;
  const repo: ToolEmbeddingRepository = {
    async listSnapshot() {
      return [{ tool_name: 'order_list', text_hash: 'old-hash', model: 'old-model', dim: 2 }];
    },
    async deleteProvider() { deletes++; },
    async upsert() { upserts++; },
    async deleteTools() { /* test double */ },
    async listVectors() { return []; },
  };
  const service = new ToolIndexService(configStore(), appConfig(), repo);
  useFetch(t, async () => new Response('upstream failed', { status: 503 }));
  await assert.rejects(() => service.reindexProvider(indexedProvider(), EMBED_CONFIG));
  assert.equal(deletes, 0, 'old coordinate must remain until every replacement vector has been computed');
  assert.equal(upserts, 0);
});

test('coordinate migration refuses non-atomic legacy storage without deleting the old index', async (t) => {
  let deletes = 0;
  let upserts = 0;
  const repo: ToolEmbeddingRepository = {
    async listSnapshot() {
      return [{ tool_name: 'order_list', text_hash: 'old-hash', model: 'old-model', dim: 2 }];
    },
    async deleteProvider() { deletes++; },
    async upsert() { upserts++; },
    async deleteTools() { /* test double */ },
    async listVectors() { return []; },
  };
  const service = new ToolIndexService(configStore(), appConfig(), repo);
  useFetch(t, async () => embeddingResponse([1, 0]));

  await assert.rejects(
    () => service.reindexProvider(indexedProvider(), EMBED_CONFIG),
    /不支持原子坐标系切换/,
  );
  assert.equal(deletes, 0);
  assert.equal(upserts, 0);
});
