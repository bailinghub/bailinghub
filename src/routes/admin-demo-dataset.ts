import type { IncomingMessage, ServerResponse } from 'node:http';
import { can, type Principal } from '../app/auth';
import { send } from '../app/http';
import {
  DemoDatasetConflictError,
  DemoDatasetUnavailableError,
  type DemoDatasetClearResult,
  type DemoDatasetImportResult,
  type DemoDatasetStatus,
} from '../services/demo-dataset';

export interface DemoDatasetServiceContract {
  status(): Promise<DemoDatasetStatus>;
  import(): Promise<DemoDatasetImportResult>;
  clear(): Promise<DemoDatasetClearResult>;
}

export interface AdminDemoDatasetApiDeps {
  demoDataset: DemoDatasetServiceContract;
  refreshTargets(): Promise<void>;
}

const WRITE_PERMISSIONS = ['targets:write', 'tools:write', 'routes:write', 'clients:write'] as const;

function canWriteDemoDataset(principal: Principal): boolean {
  return WRITE_PERMISSIONS.every((permission) => can(principal, permission));
}

export async function handleAdminDemoDatasetApiFor(
  deps: AdminDemoDatasetApiDeps,
  method: string,
  path: string,
  _req: IncomingMessage,
  res: ServerResponse,
  principal: Principal,
): Promise<boolean> {
  if (!(path === '/admin/api/demo-dataset'
    || path === '/admin/api/demo-dataset/status'
    || path === '/admin/api/demo-dataset/import')) return false;

  const statusRequest = path === '/admin/api/demo-dataset/status' && method === 'GET';
  const importRequest = path === '/admin/api/demo-dataset/import' && method === 'POST';
  const clearRequest = path === '/admin/api/demo-dataset' && method === 'DELETE';
  if (!statusRequest && !importRequest && !clearRequest) {
    res.setHeader('allow', path.endsWith('/status') ? 'GET' : path.endsWith('/import') ? 'POST' : 'DELETE');
    send(res, 405, { error: 'method not allowed' });
    return true;
  }

  if (statusRequest
    ? !(can(principal, 'audit:read') || canWriteDemoDataset(principal))
    : !canWriteDemoDataset(principal)) {
    send(res, 403, { error: '当前角色无演示数据管理权限' });
    return true;
  }

  try {
    if (statusRequest) {
      send(res, 200, await deps.demoDataset.status());
      return true;
    }
    if (importRequest) {
      const result = await deps.demoDataset.import();
      await deps.refreshTargets();
      send(res, 200, result);
      return true;
    }
    const result = await deps.demoDataset.clear();
    await deps.refreshTargets();
    send(res, 200, result);
    return true;
  } catch (error) {
    if (error instanceof DemoDatasetConflictError) {
      send(res, 409, { error: error.message, conflicts: error.conflicts });
      return true;
    }
    if (error instanceof DemoDatasetUnavailableError) {
      send(res, 503, { error: error.message });
      return true;
    }
    throw error;
  }
}
