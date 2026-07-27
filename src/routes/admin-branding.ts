import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, send } from '../app/http';
import {
  InstanceBrandingReadonlyError,
  InstanceBrandingValidationError,
  publicInstanceBranding,
  type InstanceBrandingProvider,
} from '../core/platform/instance-branding';

export interface AdminBrandingApiDeps {
  brandingProvider: InstanceBrandingProvider;
}

export async function handleAdminBrandingApiFor(
  deps: AdminBrandingApiDeps,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (path !== '/admin/api/instance-branding') return false;
  if (method === 'GET') {
    send(res, 200, {
      branding: publicInstanceBranding(await deps.brandingProvider.read()),
      management: deps.brandingProvider.management,
    });
    return true;
  }
  if (method !== 'PUT') {
    res.setHeader('allow', 'GET, PUT');
    send(res, 405, { error: 'method not allowed' });
    return true;
  }
  try {
    const updated = await deps.brandingProvider.update(await readBody(req));
    send(res, 200, {
      branding: publicInstanceBranding(updated),
      management: deps.brandingProvider.management,
    });
  } catch (error) {
    if (error instanceof InstanceBrandingValidationError || error instanceof InstanceBrandingReadonlyError) {
      send(res, error.statusCode, { error: error.message });
      return true;
    }
    throw error;
  }
  return true;
}
