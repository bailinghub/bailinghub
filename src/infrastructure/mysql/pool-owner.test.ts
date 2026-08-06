import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import type { AppConfig } from '../../core/config/config';
import { ConfigStore } from '../config/configstore';
import { MysqlStore } from '../state/state-mysql';
import type { MysqlPoolResource } from './pool-owner';

test('一个 Kernel 的 ConfigStore 与 MysqlStore 共享一组可幂等关闭的 Pool', async () => {
  const pool = {} as Pool;
  let gets = 0;
  let ends = 0;
  let closed = false;
  const owner: MysqlPoolResource = {
    async get() {
      gets++;
      if (closed) throw new Error('closed');
      return pool;
    },
    async close() {
      if (closed) return;
      closed = true;
      ends++;
    },
  };
  const config = {} as AppConfig['state']['mysql'];
  const stateStore = new MysqlStore(config, owner);
  const configStore = new ConfigStore(config, owner);

  await Promise.all([stateStore.init(), configStore.init()]);
  assert.equal(gets, 2);
  assert.equal(configStore.db, pool);

  await Promise.all([stateStore.close(), configStore.close()]);
  assert.equal(ends, 1);
});
