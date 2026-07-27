import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  InstanceBrandingReadonlyError,
  defaultInstanceBrandingSnapshot,
  type BrandingAsset,
  type BrandingAssetKind,
  type InstanceBrandingProvider,
  type InstanceBrandingSnapshot,
  type InstanceBrandingUpdate,
} from '../core/platform/instance-branding';
import { handleAdminBrandingApiFor } from './admin-branding';

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string | number | string[]> = {};
  body: Uint8Array = Buffer.alloc(0);

  writeHead(code: number, headers?: Record<string, string | number | string[]>): void {
    this.statusCode = code;
    if (headers) Object.assign(this.headers, headers);
  }

  setHeader(name: string, value: string | number | string[]): void {
    this.headers[name.toLowerCase()] = value;
  }

  end(chunk?: string | Buffer): void {
    if (chunk) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }

  json(): Record<string, unknown> {
    return JSON.parse(Buffer.from(this.body).toString('utf8')) as Record<string, unknown>;
  }
}

function request(body: Record<string, unknown> = {}): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  stream.headers = {};
  return stream;
}

class PlatformBrandingProvider implements InstanceBrandingProvider {
  readonly management = {
    source: 'platform' as const,
    writable: false,
    management_url: 'https://platform.example.com/instances/demo/branding',
  };

  async read(): Promise<InstanceBrandingSnapshot> {
    return {
      ...defaultInstanceBrandingSnapshot(),
      site_name: 'Platform Managed',
    };
  }

  async readAsset(_kind: BrandingAssetKind): Promise<BrandingAsset | null> {
    return null;
  }

  async update(_input: InstanceBrandingUpdate): Promise<InstanceBrandingSnapshot> {
    throw new InstanceBrandingReadonlyError();
  }
}

test('admin branding route: exposes platform ownership to admins without leaking it into branding data', async () => {
  const res = new FakeResponse();
  const handled = await handleAdminBrandingApiFor(
    { brandingProvider: new PlatformBrandingProvider() },
    'GET',
    '/admin/api/instance-branding',
    request(),
    res as unknown as ServerResponse,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal((body['branding'] as Record<string, unknown>)['site_name'], 'Platform Managed');
  assert.equal('management_url' in (body['branding'] as Record<string, unknown>), false);
  assert.deepEqual(body['management'], {
    source: 'platform',
    writable: false,
    management_url: 'https://platform.example.com/instances/demo/branding',
  });
});

test('admin branding route: platform-owned settings reject local writes', async () => {
  const res = new FakeResponse();
  await handleAdminBrandingApiFor(
    { brandingProvider: new PlatformBrandingProvider() },
    'PUT',
    '/admin/api/instance-branding',
    request({ site_name: 'Local override' }),
    res as unknown as ServerResponse,
  );

  assert.equal(res.statusCode, 409);
  assert.match(String(res.json()['error']), /平台统一管理/);
});

test('admin branding route: unsupported methods return an explicit Allow header', async () => {
  const res = new FakeResponse();
  await handleAdminBrandingApiFor(
    { brandingProvider: new PlatformBrandingProvider() },
    'POST',
    '/admin/api/instance-branding',
    request(),
    res as unknown as ServerResponse,
  );

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'GET, PUT');
});
