import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialRepository } from './config-credential-repository';

test('credential get forwards an optional client-side database timeout', async () => {
  const calls: unknown[][] = [];
  const repository = new CredentialRepository(() => ({
    async query(...args: unknown[]) { calls.push(args); return [[]]; },
  }));

  assert.equal(await repository.get('embedding-main', { timeoutMs: 4321 }), null);

  assert.equal(calls.length, 1);
  const query = calls[0]?.[0] as { sql: string; values: unknown[]; timeout?: number };
  assert.equal(query.sql, 'SELECT * FROM bz_credentials WHERE name=? LIMIT 1');
  assert.deepEqual(query.values, ['embedding-main']);
  assert.equal(query.timeout, 4321);
});

test('credential get keeps the legacy one-argument call compatible', async () => {
  const calls: unknown[][] = [];
  const repository = new CredentialRepository(() => ({
    async query(...args: unknown[]) { calls.push(args); return [[]]; },
  }));

  await repository.get('embedding-main');

  assert.deepEqual(calls, [[
    'SELECT * FROM bz_credentials WHERE name=? LIMIT 1',
    ['embedding-main'],
  ]]);
});
