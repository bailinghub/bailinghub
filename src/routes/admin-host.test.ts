import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { Principal } from '../app/auth';
import { adminSmokeHub, adminSmokeRunInput, handleAdminApiFor, type AdminApiDeps } from './admin';

function response() {
  let status = 0;
  let body = '';
  return {
    res: {
      writeHead(code: number) { status = code; },
      end(chunk?: string) { body += chunk ?? ''; },
    } as unknown as ServerResponse,
    status: () => status,
    json: () => JSON.parse(body) as Record<string, unknown>,
  };
}

const hostPrincipal: Principal = {
  kind: 'admin',
  via: 'session',
  username: 'host-user',
  permissions: ['*'],
};

test('admin smoke loopback includes the trusted Kernel mount prefix', () => {
  assert.equal(
    adminSmokeHub({ server: { host: '127.0.0.1', port: 3100, token: '' } }, '/tenant/tenant-a'),
    'http://127.0.0.1:3100/tenant/tenant-a',
  );
  assert.throws(
    () => adminSmokeHub({ server: { host: '127.0.0.1', port: 3100, token: '' } }, '/../escape'),
    /HTTP mount path/,
  );
});

test('admin smoke uses a read-only request for the stateless demo profile', () => {
  assert.match(adminSmokeRunInput({ demoDataset: {
    businessBaseUrl: 'http://127.0.0.1:19080',
    toolSecret: 'not-returned',
    profile: 'stateless-readonly',
  } }) ?? '', /只查询订单 SO-1001/);
  assert.equal(adminSmokeRunInput({ demoDataset: null }), undefined);
});

test('host identity cannot reach dead Core-local password or account APIs', async () => {
  for (const [method, path] of [
    ['POST', '/admin/api/password'],
    ['GET', '/admin/api/admins'],
    ['DELETE', '/admin/api/admins/legacy-user'],
  ] as const) {
    const output = response();
    assert.equal(await handleAdminApiFor(
      { localAdminManagement: false } as AdminApiDeps,
      method,
      path,
      {} as IncomingMessage,
      output.res,
      hostPrincipal,
    ), true);
    assert.equal(output.status(), 404);
    assert.match(String(output.json().error), /宿主管理/);
  }
});
