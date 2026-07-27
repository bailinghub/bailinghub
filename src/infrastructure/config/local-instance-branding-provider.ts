import {
  DEFAULT_INSTANCE_BRANDING,
  InstanceBrandingReadonlyError,
  defaultInstanceBrandingSnapshot,
  normalizeInstanceBrandingUpdate,
  type BrandingAsset,
  type BrandingAssetKind,
  type InstanceBrandingProvider,
  type InstanceBrandingSnapshot,
  type InstanceBrandingUpdate,
} from '../../core/platform/instance-branding';
import type {
  InstanceBrandingRepositoryContract,
  PersistedInstanceBranding,
} from './config-instance-branding-repository';

function revisionOf(updatedAt: string | null): string {
  if (!updatedAt) return 'default';
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? String(parsed) : updatedAt;
}

function snapshotOf(row: PersistedInstanceBranding | null): InstanceBrandingSnapshot {
  if (!row) return defaultInstanceBrandingSnapshot();
  return {
    site_name: row.site_name || DEFAULT_INSTANCE_BRANDING.site_name,
    browser_title: row.browser_title || DEFAULT_INSTANCE_BRANDING.browser_title,
    site_description: row.site_description,
    site_keywords: [...row.site_keywords],
    login_heading: row.login_heading || DEFAULT_INSTANCE_BRANDING.login_heading,
    login_subheading: row.login_subheading,
    has_logo: !!(row.logo_content_type && row.logo_data?.length),
    has_favicon: !!(row.favicon_content_type && row.favicon_data?.length),
    revision: revisionOf(row.updated_at),
    updated_at: row.updated_at,
  };
}

export class LocalInstanceBrandingProvider implements InstanceBrandingProvider {
  constructor(private readonly repository: InstanceBrandingRepositoryContract | null) {}

  get management() {
    return {
      source: 'local' as const,
      writable: !!this.repository,
    };
  }

  async read(): Promise<InstanceBrandingSnapshot> {
    return snapshotOf(this.repository ? await this.repository.get() : null);
  }

  async readAsset(kind: BrandingAssetKind): Promise<BrandingAsset | null> {
    if (!this.repository) return null;
    const row = await this.repository.get();
    if (!row) return null;
    const contentType = kind === 'logo' ? row.logo_content_type : row.favicon_content_type;
    const data = kind === 'logo' ? row.logo_data : row.favicon_data;
    if (!contentType || !data?.length) return null;
    return { contentType, data: Buffer.from(data), revision: revisionOf(row.updated_at) };
  }

  async update(input: InstanceBrandingUpdate): Promise<InstanceBrandingSnapshot> {
    if (!this.repository) throw new InstanceBrandingReadonlyError('当前存储后端不支持保存品牌设置，请使用 MySQL');
    const existing = await this.repository.get();
    const current = snapshotOf(existing);
    const update = normalizeInstanceBrandingUpdate(input, current);
    const row: PersistedInstanceBranding = {
      ...update.text,
      logo_content_type: update.logo === undefined ? existing?.logo_content_type ?? null : update.logo?.contentType ?? null,
      logo_data: update.logo === undefined ? existing?.logo_data ?? null : update.logo?.data ?? null,
      favicon_content_type: update.favicon === undefined ? existing?.favicon_content_type ?? null : update.favicon?.contentType ?? null,
      favicon_data: update.favicon === undefined ? existing?.favicon_data ?? null : update.favicon?.data ?? null,
      updated_at: new Date().toISOString(),
    };
    await this.repository.save(row);
    return snapshotOf(await this.repository.get());
  }
}
