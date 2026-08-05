import assert from 'node:assert/strict';
import test from 'node:test';
import { MysqlToolEmbeddingRepository } from './config-tool-embedding-repository';
import type { ToolEmbeddingUpsert } from '../../services/tool-index-repository';

function upsert(toolName: string): ToolEmbeddingUpsert {
  return {
    provider: 'orders',
    tool_name: toolName,
    scope: 'order.read',
    text: toolName,
    text_hash: `${toolName}-hash`,
    model: 'embedding-model-v2',
    dim: 2,
    embedding: Buffer.alloc(8),
    updated_at: '2026-08-05 00:00:00',
  };
}

test('listVectors scopes vectors by provider/model/dim and forwards the database timeout', async () => {
  const embedding = Buffer.from([1, 2, 3, 4]);
  const calls: unknown[][] = [];
  const pool = {
    async query(...args: unknown[]) {
      calls.push(args);
      return [[
        { tool_name: 'order_list', scope: 'order.read', embedding, model: 'embedding-model-v1', dim: 1024 },
        { tool_name: 'order_get', scope: null, embedding, model: 'embedding-model-v1', dim: 1024 },
      ]];
    },
  };
  const repository = new MysqlToolEmbeddingRepository(() => pool);

  const rows = await repository.listVectors('orders', {
    model: 'embedding-model-v1',
    dim: 1024,
    timeoutMs: 4321,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.length, 1);
  const query = calls[0]?.[0] as { sql: string; values: unknown[]; timeout?: number };
  assert.match(query.sql, /^SELECT tool_name,scope,embedding,model,dim FROM bz_tool_embeddings WHERE provider=\? AND model=\? AND dim=\?$/);
  assert.deepEqual(query.values, ['orders', 'embedding-model-v1', 1024]);
  assert.equal(query.timeout, 4321);
  assert.deepEqual(rows, [
    { tool_name: 'order_list', scope: 'order.read', embedding, model: 'embedding-model-v1', dim: 1024 },
    { tool_name: 'order_get', scope: '', embedding, model: 'embedding-model-v1', dim: 1024 },
  ]);
});

test('listVectors keeps the legacy provider-only call compatible', async () => {
  const calls: unknown[][] = [];
  const pool = {
    async query(...args: unknown[]) { calls.push(args); return [[]]; },
  };
  const repository = new MysqlToolEmbeddingRepository(() => pool);

  await repository.listVectors('orders');

  assert.deepEqual(calls, [[
    'SELECT tool_name,scope,embedding,model,dim FROM bz_tool_embeddings WHERE provider=?',
    ['orders'],
  ]]);
});

test('listSnapshot forwards the database timeout for legacy coordinate verification', async () => {
  const calls: unknown[][] = [];
  const pool = {
    async query(...args: unknown[]) {
      calls.push(args);
      return [[{ tool_name: 'order_list', text_hash: 'hash', model: 'embedding-model-v1', dim: 1024 }]];
    },
  };
  const repository = new MysqlToolEmbeddingRepository(() => pool);

  const rows = await repository.listSnapshot('orders', { timeoutMs: 4321 });

  const query = calls[0]?.[0] as { sql: string; values: unknown[]; timeout?: number };
  assert.match(query.sql, /^SELECT tool_name,text_hash,model,dim FROM bz_tool_embeddings WHERE provider=\?$/);
  assert.deepEqual(query.values, ['orders']);
  assert.equal(query.timeout, 4321);
  assert.deepEqual(rows, [{ tool_name: 'order_list', text_hash: 'hash', model: 'embedding-model-v1', dim: 1024 }]);
});

test('replaceProvider commits one atomic coordinate cutover', async () => {
  const events: string[] = [];
  const connection = {
    async beginTransaction() { events.push('begin'); },
    async query(sql: string) { events.push(sql.startsWith('DELETE') ? 'delete' : 'upsert'); },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    release() { events.push('release'); },
  };
  const repository = new MysqlToolEmbeddingRepository(() => ({
    async getConnection() { return connection; },
  }));

  await repository.replaceProvider('orders', [upsert('order_list'), upsert('order_get')]);

  assert.deepEqual(events, ['begin', 'delete', 'upsert', 'upsert', 'commit', 'release']);
});

test('replaceProvider rolls back a failed coordinate cutover', async () => {
  const events: string[] = [];
  let writes = 0;
  const connection = {
    async beginTransaction() { events.push('begin'); },
    async query(sql: string) {
      events.push(sql.startsWith('DELETE') ? 'delete' : 'upsert');
      if (!sql.startsWith('DELETE') && ++writes === 2) throw new Error('write failed');
    },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    release() { events.push('release'); },
  };
  const repository = new MysqlToolEmbeddingRepository(() => ({
    async getConnection() { return connection; },
  }));

  await assert.rejects(() => repository.replaceProvider('orders', [upsert('order_list'), upsert('order_get')]), /write failed/);

  assert.deepEqual(events, ['begin', 'delete', 'upsert', 'upsert', 'rollback', 'release']);
});
