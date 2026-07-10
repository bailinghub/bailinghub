import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRuntimeComposition,
  createRuntimeContext,
  handlePublicHttpFor,
  type AppConfig,
  type ConfigStoreContract,
  type RuntimeStateStore,
  type StoreFactory,
} from './extension-api';

const root = fileURLToPath(new URL('..', import.meta.url));

test('extension-api exposes injectable runtime primitives without default singletons', () => {
  const source = readFileSync(join(root, 'src', 'extension-api.ts'), 'utf8');
  assert.equal(source.includes('-default'), false);
  assert.equal(/from ['"]\.\/app\/runtime['"]/.test(source), false);
  assert.equal(/from ['"]\.\/server['"]/.test(source), false);
  assert.equal(/from ['"]\.\/executor['"]/.test(source), false);
  assert.equal(typeof handlePublicHttpFor, 'function');
});

test('extension-api can compose a runtime from injected edition stores', () => {
  const stateStore = {} as RuntimeStateStore;
  const storeFactory: StoreFactory<ConfigStoreContract | null, RuntimeStateStore> = {
    state: () => stateStore,
    config: () => null,
  };
  const systemContext = createRuntimeContext({ requestId: 'extension-api-test', source: 'system' });
  const cfg = { concurrency: 1 } as AppConfig;

  const runtime = createRuntimeComposition({
    cfg,
    edition: { systemContext, storeFactory },
    registerAdapters: false,
  });

  assert.equal(runtime.runtimeContext, systemContext);
  assert.equal(runtime.storeFactory, storeFactory);
  assert.equal(runtime.store, stateStore);
  assert.equal(runtime.cfgStore, null);
});

test('package exports the stable extension-api subpath', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports?: Record<string, { default?: string; types?: string } | string>;
  };
  assert.deepEqual(pkg.exports?.['./extension-api'], {
    types: './src/extension-api.ts',
    default: './src/extension-api.ts',
  });
});

test('package self-reference can import bailinghub/extension-api', async () => {
  const api = await import('bailinghub/extension-api');
  assert.equal(typeof api.createRuntimeComposition, 'function');
  assert.equal(typeof api.createBailingHttpServer, 'function');
  assert.equal(typeof api.handlePublicHttpFor, 'function');
});
