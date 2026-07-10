import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDedicatedAuthzProbe, dedicatedAuthzProbeTarget } from './tool-specs';

test('dedicatedAuthzProbeTarget: 支持 root 声明专用授权探针', () => {
  const spec = JSON.stringify({
    openapi: '3.0.0',
    'x-bailing-authz-probe': { method: 'POST', path: '/.well-known/bailing/authz-probe', operationId: 'checkAuthz' },
    paths: {},
  });
  assert.deepEqual(dedicatedAuthzProbeTarget(spec), {
    method: 'POST',
    path: '/.well-known/bailing/authz-probe',
    name: 'checkAuthz',
  });
});

test('dedicatedAuthzProbeTarget: 支持 operation 标记专用授权探针', () => {
  const spec = JSON.stringify({
    openapi: '3.0.0',
    paths: {
      '/bailing/authz-probe': {
        get: { operationId: 'authzProbe', 'x-bailing-authz-probe': true },
      },
    },
  });
  assert.deepEqual(dedicatedAuthzProbeTarget(spec), {
    method: 'GET',
    path: '/bailing/authz-probe',
    name: 'authzProbe',
  });
});

test('classifyDedicatedAuthzProbe: 专用探针按授权布尔结论分类', () => {
  assert.equal(classifyDedicatedAuthzProbe(200, '{"authorized":false}', 'probe').status, 'pass');
  assert.equal(classifyDedicatedAuthzProbe(200, '{"allow":true}', 'probe').status, 'suspect');
  assert.equal(classifyDedicatedAuthzProbe(403, '', 'probe').status, 'pass');
  assert.equal(classifyDedicatedAuthzProbe(200, '{}', 'probe').status, 'inconclusive');
});
