import test from 'node:test';
import assert from 'node:assert/strict';
import { InstanceBrandingReadonlyError } from '../../core/platform/instance-branding';
import {
  LocalInstanceBrandingProvider,
} from './local-instance-branding-provider';
import type {
  InstanceBrandingRepositoryContract,
  PersistedInstanceBranding,
} from './config-instance-branding-repository';

class MemoryBrandingRepository implements InstanceBrandingRepositoryContract {
  row: PersistedInstanceBranding | null = null;

  async get(): Promise<PersistedInstanceBranding | null> {
    if (!this.row) return null;
    return {
      ...this.row,
      site_keywords: [...this.row.site_keywords],
      logo_data: this.row.logo_data ? Buffer.from(this.row.logo_data) : null,
      favicon_data: this.row.favicon_data ? Buffer.from(this.row.favicon_data) : null,
    };
  }

  async save(value: PersistedInstanceBranding): Promise<void> {
    this.row = {
      ...value,
      site_keywords: [...value.site_keywords],
      logo_data: value.logo_data ? Buffer.from(value.logo_data) : null,
      favicon_data: value.favicon_data ? Buffer.from(value.favicon_data) : null,
      updated_at: '2026-07-27T08:00:00.000Z',
    };
  }
}

test('local branding provider: local storage is writable and preserves omitted assets', async () => {
  const repository = new MemoryBrandingRepository();
  repository.row = {
    site_name: 'Before',
    browser_title: 'Before Console',
    site_description: '',
    site_keywords: ['before'],
    login_heading: 'Before heading',
    login_subheading: '',
    logo_content_type: 'image/png',
    logo_data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    favicon_content_type: null,
    favicon_data: null,
    updated_at: '2026-07-26T08:00:00.000Z',
  };
  const provider = new LocalInstanceBrandingProvider(repository);

  const updated = await provider.update({ site_name: 'After' });

  assert.deepEqual(provider.management, { source: 'local', writable: true });
  assert.equal(updated.site_name, 'After');
  assert.equal(updated.has_logo, true);
  assert.equal(repository.row?.logo_content_type, 'image/png');
  assert.equal(repository.row?.logo_data?.length, 8);
});

test('local branding provider: null explicitly removes an asset', async () => {
  const repository = new MemoryBrandingRepository();
  repository.row = {
    site_name: 'Before',
    browser_title: 'Before Console',
    site_description: '',
    site_keywords: [],
    login_heading: 'Before heading',
    login_subheading: '',
    logo_content_type: 'image/png',
    logo_data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    favicon_content_type: null,
    favicon_data: null,
    updated_at: '2026-07-26T08:00:00.000Z',
  };
  const provider = new LocalInstanceBrandingProvider(repository);

  const updated = await provider.update({ logo_data_url: null });

  assert.equal(updated.has_logo, false);
  assert.equal(repository.row?.logo_content_type, null);
  assert.equal(repository.row?.logo_data, null);
});

test('local branding provider: missing persistent repository fails closed for writes', async () => {
  const provider = new LocalInstanceBrandingProvider(null);

  assert.deepEqual(provider.management, { source: 'local', writable: false });
  await assert.rejects(
    () => provider.update({ site_name: 'Not persisted' }),
    InstanceBrandingReadonlyError,
  );
});
