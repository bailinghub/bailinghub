import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { KnowledgeRepository, KbDocRecord, KbIndexRecord } from './kb-repository';
import { KbService, agentKnowledgeDocumentRevision, chunkText } from './kb';

function fixture() {
  const documents = new Map<number, KbDocRecord>([[1, { doc_id: 1, kb_id: 'allowed', title: '装修指南', content: '装修必须绑定页面设置。\n\n其余步骤按需读取。',
    content_hash: 'legacy-hash', status: 'ready', chunk_count: 1, created_at: '', updated_at: '' }]]);
  const disabled = new Set<string>(); const failed = new Set<string>(); let indexReads = 0;
  const vector = Float32Array.from([1, 0]);
  let rows: KbIndexRecord[] = [{ id: 1, doc_id: 1, seq: 0, title: '装修指南', content: chunkText(documents.get(1)!.content)[0]!,
    embedding: Buffer.from(vector.buffer) }];
  const repository = { getBase: async (kb: string) => failed.has(kb) ? null : { kb_id: kb, name: 'not-returned-name', credential: 'embedding-secret-name',
    model: 'synthetic', dim: 2, enabled: !disabled.has(kb) }, getDoc: async (id: number) => documents.get(id) ?? null,
    listIndexRows: async (kb: string) => { indexReads++; if (failed.has(kb)) throw new Error('raw-sql-private'); return kb === 'allowed' ? rows : []; } } as unknown as KnowledgeRepository;
  const store = { credentials: { get: async () => ({ enabled: true, kind: 'embedding', base_url: 'https://synthetic.invalid', api_key: 'secret' }), touch: async () => undefined } } as unknown as ConfigStoreContract;
  const service = new KbService(store, {} as AppConfig, repository);
  return { service, documents, disabled, failed, rows: () => rows, setRows: (value: KbIndexRecord[]) => { rows = value; }, indexReads: () => indexReads };
}

test('Agent retrieval uses fresh index rows and current ready document snapshots without populating native cache', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
  const f = fixture();
  const first = await f.service.searchForAgent(['allowed'], '装修', 8, 0.5, 3);
  assert.equal(first.status, 'ok'); assert.equal(first.documents.length, 1);
  assert.equal(first.documents[0]!.revision, agentKnowledgeDocumentRevision('装修指南', f.documents.get(1)!.content));
  assert.equal(first.documents[0]!.summary, f.rows()[0]!.content);
  await f.service.searchForAgent(['allowed'], '装修', 8, 0.5, 3);
  assert.equal(f.indexReads(), 2);
  assert.equal((f.service as unknown as { indexCache: Map<string, unknown> }).indexCache.size, 0);
});

test('Agent retrieval discards stale chunks, stale titles, nonready documents, wrong-KB parents and deleted documents', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
  for (const failure of ['content', 'title', 'embedding', 'error', 'wrong_kb', 'deleted']) {
    const f = fixture(); const doc = f.documents.get(1)!;
    if (failure === 'content') doc.content = '替换后的原文不包含旧设计。';
    if (failure === 'title') doc.title = '已更名';
    if (failure === 'embedding' || failure === 'error') doc.status = failure;
    if (failure === 'wrong_kb') doc.kb_id = 'unavailable';
    if (failure === 'deleted') f.documents.delete(1);
    const result = await f.service.searchForAgent(['allowed'], '装修', 8, 0.5, 3);
    assert.equal(result.status, 'ok', failure); assert.deepEqual(result.documents, [], failure);
  }
});

test('Agent retrieval distinguishes real empty matches, partial failure and total unavailability', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
  const f = fixture();
  const empty = await f.service.searchForAgent(['empty'], '装修', 8, 0.5, 3);
  assert.equal(empty.status, 'ok'); assert.deepEqual(empty.documents, []);
  f.failed.add('broken');
  assert.equal((await f.service.searchForAgent(['allowed', 'broken'], '装修', 8, 0.5, 3)).status, 'partial');
  assert.equal((await f.service.searchForAgent(['broken'], '装修', 8, 0.5, 3)).status, 'unavailable');
  f.disabled.add('allowed');
  assert.equal((await f.service.searchForAgent(['allowed'], '装修', 8, 0.5, 3)).status, 'unavailable');
});

test('Agent retrieval keeps configured min_score and deduplicates parent documents without filling weak matches', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
  const f = fixture(); const weak = Float32Array.from([0.2, 0.98]);
  f.setRows([{ ...f.rows()[0]!, embedding: Buffer.from(weak.buffer) }]);
  assert.deepEqual((await f.service.searchForAgent(['allowed'], '装修', 8, 0.5, 3)).documents, []);
  assert.equal((await f.service.searchForAgent(['allowed'], '装修', 8, 0.1, 3)).documents.length, 1);
  f.setRows([f.rows()[0]!, { ...f.rows()[0]!, id: 2 }]);
  assert.equal((await f.service.searchForAgent(['allowed'], '装修', 8, 0.1, 3)).documents.length, 1);
});

test('Agent snapshots require enabled KB, exact ownership, ready state and recalculate actual title/body revisions', async () => {
  const f = fixture(); const original = await f.service.getAgentDocumentSnapshot('allowed', 1);
  assert.ok(original); f.documents.get(1)!.content += '新内容';
  const current = await f.service.getAgentDocumentSnapshot('allowed', 1); assert.notEqual(current!.revision, original.revision);
  assert.equal(await f.service.getAgentDocumentSnapshot('another', 1), null);
  f.disabled.add('allowed'); assert.equal(await f.service.getAgentDocumentSnapshot('allowed', 1), null);
});

test('Agent embedding failures are reflected as unavailability without returning upstream secrets', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('secret-api-key private-host raw-body'); });
  const f = fixture(); const result = await f.service.searchForAgent(['allowed'], '装修', 8, 0.5, 3);
  assert.deepEqual(result, { status: 'unavailable', documents: [], truncated: false });
  assert.doesNotMatch(JSON.stringify(result), /secret|private-host|raw-body/);
});
