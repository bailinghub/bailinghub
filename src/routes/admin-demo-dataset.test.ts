import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { Principal } from '../app/auth';
import {
  DemoDatasetConflictError,
  type DemoDatasetClearResult,
  type DemoDatasetImportResult,
  type DemoDatasetStatus,
} from '../services/demo-dataset';
import { handleAdminDemoDatasetApiFor, type DemoDatasetServiceContract } from './admin-demo-dataset';

const emptyStatus: DemoDatasetStatus = {
  available: true,
  imported: false,
  empty: true,
  counts: { routes: 0, clients: 0, tool_providers: 0, targets: 1, channels: 0, chat_entries: 0, jobs: 0, approvals: 0 },
};

function principal(permissions: string[]): Principal {
  return { kind: 'admin', via: 'session', username: 'operator', permissions };
}

function response(): { res: ServerResponse; status(): number; json(): Record<string, unknown> } {
  let status = 0;
  let body = '';
  const headers = new Map<string, unknown>();
  return {
    res: {
      writeHead(code: number) { status = code; },
      setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); },
      end(chunk?: string) { body += chunk ?? ''; },
    } as unknown as ServerResponse,
    status: () => status,
    json: () => JSON.parse(body) as Record<string, unknown>,
  };
}

function service(overrides: Partial<DemoDatasetServiceContract> = {}): DemoDatasetServiceContract {
  return {
    status: async () => emptyStatus,
    import: async () => ({ ok: true, ...emptyStatus, imported: true, created: [] } as DemoDatasetImportResult),
    clear: async () => ({ ok: true, ...emptyStatus, removed: [] } as DemoDatasetClearResult),
    ...overrides,
  };
}

test('demo dataset admin API: status 与写入分别使用审计权限和四类聚合写权限', async () => {
  const statusOut = response();
  await handleAdminDemoDatasetApiFor(
    { demoDataset: service(), refreshTargets: async () => undefined },
    'GET', '/admin/api/demo-dataset/status', {} as IncomingMessage, statusOut.res,
    principal(['audit:read']),
  );
  assert.equal(statusOut.status(), 200);

  for (const missing of ['targets:write', 'tools:write', 'routes:write', 'clients:write']) {
    const out = response();
    const permissions = ['targets:write', 'tools:write', 'routes:write', 'clients:write'].filter((item) => item !== missing);
    await handleAdminDemoDatasetApiFor(
      { demoDataset: service(), refreshTargets: async () => undefined },
      'POST', '/admin/api/demo-dataset/import', {} as IncomingMessage, out.res,
      principal(permissions),
    );
    assert.equal(out.status(), 403, `missing ${missing}`);
  }
});

test('demo dataset admin API: import 成功后刷新 target registry', async () => {
  let refreshed = 0;
  const out = response();
  await handleAdminDemoDatasetApiFor(
    { demoDataset: service(), refreshTargets: async () => { refreshed += 1; } },
    'POST', '/admin/api/demo-dataset/import', {} as IncomingMessage, out.res,
    principal(['targets:write', 'tools:write', 'routes:write', 'clients:write']),
  );
  assert.equal(out.status(), 200);
  assert.equal(refreshed, 1);
});

test('demo dataset admin API: ownership 冲突显式返回 409', async () => {
  const out = response();
  await handleAdminDemoDatasetApiFor(
    {
      demoDataset: service({ import: async () => { throw new DemoDatasetConflictError('同名冲突', ['route:demo_support']); } }),
      refreshTargets: async () => undefined,
    },
    'POST', '/admin/api/demo-dataset/import', {} as IncomingMessage, out.res,
    principal(['*']),
  );
  assert.equal(out.status(), 409);
  assert.deepEqual(out.json()['conflicts'], ['route:demo_support']);
});
