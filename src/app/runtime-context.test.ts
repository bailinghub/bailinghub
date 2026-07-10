import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeContext, type RuntimeContext } from '../core/edition';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { createRuntimeContextHelpers } from './runtime-context';

test('createRuntimeContextHelpers 使用注入的 scopeResolver、storeFactory 和项目回退配置', async () => {
  const stateStore = { marker: 'scoped-state' } as unknown as RuntimeStateStore;
  const configStore = {
    marker: 'scoped-config',
    projects: {
      async get(name: string) {
        if (name !== 'from-db') return null;
        return { name, path: '/srv/from-db', enabled: true };
      },
    },
  } as unknown as ConfigStoreContract;
  let storeCtx: RuntimeContext | null = null;

  const helpers = createRuntimeContextHelpers({
    cfg: { projects: { fallback: '/srv/fallback' } },
    scopeResolver: {
      async resolve(input) {
        return createRuntimeContext({
          edition: 'extended',
          scope: { kind: 'org', id: 'org-a', capabilities: ['org_scope'] },
          source: input.source,
          requestId: input.requestId,
          actor: input.actor,
        });
      },
    },
    storeFactory: {
      config(ctx) {
        storeCtx = ctx;
        return configStore;
      },
      state(ctx) {
        storeCtx = ctx;
        return stateStore;
      },
    },
  });

  const ctx = await helpers.runtimeContextFor({
    source: 'run',
    requestId: 'req-1',
    actor: { kind: 'org-admin', id: 'u1', roles: ['owner'] },
  });
  assert.equal(ctx.edition, 'extended');
  assert.deepEqual(ctx.scope, { kind: 'org', id: 'org-a', capabilities: ['org_scope'] });

  const stores = helpers.runtimeStoresFor(ctx);
  assert.equal(stores.state, stateStore);
  assert.equal(stores.config, configStore);
  assert.equal(storeCtx, ctx);
  assert.equal(await helpers.resolveProjectPathFor(configStore, 'from-db'), '/srv/from-db');
  assert.equal(await helpers.resolveProjectPathFor(null, 'fallback'), '/srv/fallback');
});
