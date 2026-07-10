import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeContext } from '../core/edition';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import { OssStoreFactory } from './oss-edition';

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
