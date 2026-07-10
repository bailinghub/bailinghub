import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../core/config/config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { checkReadinessFor } from './readiness';

test('checkReadinessFor: MySQL 可达且迁移齐全才 ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bailing-ready-'));
  try {
    mkdirSync(join(root, 'sql'));
    writeFileSync(join(root, 'sql', '001_init.sql'), 'SELECT 1;');
    const cfg = { root, state: { backend: 'mysql' } } as unknown as AppConfig;
    const store = {
      db: { query: async () => [[]] },
      observability: { listSchemaMigrations: async () => ['001_init.sql'] },
    } as unknown as ConfigStoreContract;
    assert.equal((await checkReadinessFor(cfg, store)).ready, true);
    (store.observability.listSchemaMigrations as () => Promise<string[]>) = async () => [];
    const pending = await checkReadinessFor(cfg, store);
    assert.equal(pending.ready, false);
    assert.deepEqual(pending.checks.migrations, { status: 'pending', pending: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkReadinessFor: 数据库异常只输出稳定状态', async () => {
  const cfg = { root: process.cwd(), state: { backend: 'mysql' } } as unknown as AppConfig;
  const store = { db: { query: async () => { throw new Error('mysql://secret@internal'); } } } as unknown as ConfigStoreContract;
  assert.deepEqual(await checkReadinessFor(cfg, store), {
    ready: false,
    checks: { state_backend: 'ok', database: 'failed', migrations: { status: 'failed', pending: 0 } },
  });
});
