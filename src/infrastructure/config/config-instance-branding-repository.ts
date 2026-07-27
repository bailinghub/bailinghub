import { dt } from '../../core/config/config-codec';
import type { InstanceBrandingText } from '../../core/platform/instance-branding';

export interface PersistedInstanceBranding extends InstanceBrandingText {
  logo_content_type: string | null;
  logo_data: Buffer | null;
  favicon_content_type: string | null;
  favicon_data: Buffer | null;
  updated_at: string;
}

export interface InstanceBrandingRepositoryContract {
  get(): Promise<PersistedInstanceBranding | null>;
  save(value: PersistedInstanceBranding): Promise<void>;
}

function jsonStringArray(value: unknown): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

export class InstanceBrandingRepository implements InstanceBrandingRepositoryContract {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async get(): Promise<PersistedInstanceBranding | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_instance_branding WHERE singleton_id=1 LIMIT 1');
    const row = rows[0];
    if (!row) return null;
    return {
      site_name: String(row.site_name ?? ''),
      browser_title: String(row.browser_title ?? ''),
      site_description: String(row.site_description ?? ''),
      site_keywords: jsonStringArray(row.site_keywords),
      login_heading: String(row.login_heading ?? ''),
      login_subheading: String(row.login_subheading ?? ''),
      logo_content_type: row.logo_content_type ? String(row.logo_content_type) : null,
      logo_data: row.logo_data ? Buffer.from(row.logo_data) : null,
      favicon_content_type: row.favicon_content_type ? String(row.favicon_content_type) : null,
      favicon_data: row.favicon_data ? Buffer.from(row.favicon_data) : null,
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }

  async save(value: PersistedInstanceBranding): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_instance_branding ' +
      '(singleton_id,site_name,browser_title,site_description,site_keywords,login_heading,login_subheading,logo_content_type,logo_data,favicon_content_type,favicon_data,created_at,updated_at) ' +
      'VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?) ' +
      'ON DUPLICATE KEY UPDATE site_name=VALUES(site_name),browser_title=VALUES(browser_title),site_description=VALUES(site_description),' +
      'site_keywords=VALUES(site_keywords),login_heading=VALUES(login_heading),login_subheading=VALUES(login_subheading),' +
      'logo_content_type=VALUES(logo_content_type),logo_data=VALUES(logo_data),favicon_content_type=VALUES(favicon_content_type),' +
      'favicon_data=VALUES(favicon_data),updated_at=VALUES(updated_at)',
      [
        value.site_name,
        value.browser_title,
        value.site_description,
        JSON.stringify(value.site_keywords),
        value.login_heading,
        value.login_subheading,
        value.logo_content_type,
        value.logo_data,
        value.favicon_content_type,
        value.favicon_data,
        dt(),
        dt(),
      ],
    );
  }
}
