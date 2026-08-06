import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeContext } from '../core/edition';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { MysqlPoolResource } from '../infrastructure/mysql/pool-owner';
import { createOssEdition, OssStoreFactory } from './oss-edition';

test('OssStoreFactory only serves the OSS single/default scope', () => {
  const stateStore = {} as RuntimeStateStore;
  const factory = new OssStoreFactory(stateStore, null);
  const singleCtx = createRuntimeContext({ requestId: 'req-single', source: 'system' });
  const orgCtx = createRuntimeContext({
    requestId: 'req-org',
    source: 'system',
    scope: { kind: 'org', id: 'org-1', capabilities: [] },
  });

  assert.equal(factory.state(singleCtx), stateStore);
  assert.equal(factory.config(singleCtx), null);
  assert.throws(() => factory.state(orgCtx), /开源版只支持 single\/default scope/);
  assert.throws(() => factory.config(orgCtx), /开源版只支持 single\/default scope/);
});

function mysqlConfig(): AppConfig {
  return {
    state: {
      backend: 'mysql',
      mysql: { host: 'db', port: 3306, database: 'tenant', user: 'u', password: 'p', connectionLimit: 1 },
    },
  } as AppConfig;
}

test('OssEdition close shares an in-flight resource close and remains idempotent after completion', async () => {
  let closes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const mysqlPool = {
    async get() { throw new Error('not used'); },
    async close() {
      closes++;
      await gate;
    },
  } as MysqlPoolResource;
  const edition = createOssEdition(mysqlConfig(), { mysqlPool });

  const first = edition.close();
  const second = edition.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
  release();
  await Promise.all([first, second]);
  await edition.close();
  assert.equal(closes, 1);
});

test('OssEdition close clears a rejected attempt so the same edition can retry', async () => {
  let closes = 0;
  const mysqlPool = {
    async get() { throw new Error('not used'); },
    async close() {
      closes++;
      if (closes === 1) throw new Error('temporary close failure');
    },
  } as MysqlPoolResource;
  const edition = createOssEdition(mysqlConfig(), { mysqlPool });

  await assert.rejects(edition.close(), /temporary close failure/);
  await edition.close();
  assert.equal(closes, 2);
});
