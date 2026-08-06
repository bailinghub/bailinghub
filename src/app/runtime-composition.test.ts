import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeContext, type StoreFactory } from '../core/edition';
import type { AppConfig } from '../core/config/config';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { createRuntimeComposition } from './runtime-composition';

test('createRuntimeComposition uses the supplied edition and stores without OSS singleton state', () => {
  const stateStore = {} as RuntimeStateStore;
  const storeFactory: StoreFactory<ConfigStoreContract | null, RuntimeStateStore> = {
    state: () => stateStore,
    config: () => null,
  };
  const systemContext = createRuntimeContext({ requestId: 'boot-test', source: 'system' });
  const cfg = { concurrency: 2 } as AppConfig;

  const runtime = createRuntimeComposition({
    cfg,
    edition: { systemContext, storeFactory },
    registerAdapters: false,
  });

  assert.equal(runtime.cfg, cfg);
  assert.equal(runtime.runtimeContext, systemContext);
  assert.equal(runtime.storeFactory, storeFactory);
  assert.equal(runtime.store, stateStore);
  assert.equal(runtime.cfgStore, null);
  assert.equal(runtime.kbService, null);
  assert.equal(runtime.kbSync, null);
  assert.equal(runtime.toolIndex, null);
  assert.ok(runtime.targetRegistry);
  assert.deepEqual(runtime.queue.stats(), { running: 0, waiting: 0 });
});

test('createRuntimeComposition gives separate kernels separate target registries', () => {
  const stateStore = {} as RuntimeStateStore;
  const storeFactory: StoreFactory<ConfigStoreContract | null, RuntimeStateStore> = {
    state: () => stateStore,
    config: () => null,
  };
  const systemContext = createRuntimeContext({ requestId: 'boot-isolation', source: 'system' });
  const cfg = { concurrency: 1 } as AppConfig;
  const one = createRuntimeComposition({ cfg, edition: { systemContext, storeFactory } });
  const two = createRuntimeComposition({ cfg, edition: { systemContext, storeFactory } });

  one.targetRegistry.setTargets([{ name: 'tenant-only', kind: 'executor', stateless: false, needs_project: false, timeout_ms: 1000, enabled: true }]);

  assert.equal(one.targetRegistry.isKnown('tenant-only'), true);
  assert.equal(two.targetRegistry.isKnown('tenant-only'), false);
});
