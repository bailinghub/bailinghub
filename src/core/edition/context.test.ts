import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeContext, isSingleScope, SingleScopeResolver, SINGLE_SCOPE_CAPABILITY, SINGLE_SCOPE_ID, SINGLE_SCOPE_KIND } from './index';

test('createRuntimeContext defaults to the OSS single scope', () => {
  const ctx = createRuntimeContext({ requestId: 'req-1', source: 'system' });
  assert.equal(ctx.edition, 'oss');
  assert.equal(ctx.scope.kind, SINGLE_SCOPE_KIND);
  assert.equal(ctx.scope.id, SINGLE_SCOPE_ID);
  assert.deepEqual(ctx.scope.capabilities, [SINGLE_SCOPE_CAPABILITY]);
  assert.equal(isSingleScope(ctx.scope), true);
});

test('SingleScopeResolver keeps scope neutral and maps actor when provided', async () => {
  const resolver = new SingleScopeResolver<{ id: string }>((auth) => auth ? { kind: 'client', id: auth.id, roles: ['caller'] } : undefined);
  const ctx = await resolver.resolve({ source: 'run', requestId: 'req-2', auth: { id: 'demo-app' } });
  assert.equal(ctx.scope.kind, 'single');
  assert.equal(ctx.actor.kind, 'client');
  assert.equal(ctx.actor.id, 'demo-app');
});
