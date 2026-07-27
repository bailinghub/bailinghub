export type BrandingAssetKind = 'logo' | 'favicon';

export interface InstanceBrandingText {
  site_name: string;
  browser_title: string;
  site_description: string;
  site_keywords: string[];
  login_heading: string;
  login_subheading: string;
}

export interface InstanceBrandingSnapshot extends InstanceBrandingText {
  has_logo: boolean;
  has_favicon: boolean;
  revision: string;
  updated_at: string | null;
}

export interface InstanceBrandingPublicView extends InstanceBrandingSnapshot {
  logo_url: string | null;
  favicon_url: string | null;
}

export interface BrandingAsset {
  contentType: string;
  data: Buffer;
  revision: string;
}

export interface InstanceBrandingManagement {
  source: 'local' | 'platform';
  writable: boolean;
  management_url?: string;
}

export interface InstanceBrandingUpdate {
  site_name?: unknown;
  browser_title?: unknown;
  site_description?: unknown;
  site_keywords?: unknown;
  login_heading?: unknown;
  login_subheading?: unknown;
  logo_data_url?: unknown;
  favicon_data_url?: unknown;
}

export interface NormalizedInstanceBrandingUpdate {
  text: InstanceBrandingText;
  logo: BrandingAsset | null | undefined;
  favicon: BrandingAsset | null | undefined;
}

export interface InstanceBrandingProvider {
  readonly management: InstanceBrandingManagement;
  read(): Promise<InstanceBrandingSnapshot>;
  readAsset(kind: BrandingAssetKind): Promise<BrandingAsset | null>;
  update(input: InstanceBrandingUpdate): Promise<InstanceBrandingSnapshot>;
}

export const DEFAULT_INSTANCE_BRANDING: Readonly<InstanceBrandingText> = Object.freeze({
  site_name: '百灵中枢',
  browser_title: '百灵中枢 · 控制台',
  site_description: '开源、自托管的 Agent 业务动作治理控制面',
  site_keywords: ['Agent 治理', 'AI 控制面', 'BailingHub'],
  login_heading: '把业务系统接成可治理的 AI 操作入口',
  login_subheading: '从触发路由、工具声明、审批意图到审计追溯，所有运行痕迹留在自己的控制台里。',
});

export class InstanceBrandingValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InstanceBrandingValidationError';
  }
}

export class InstanceBrandingReadonlyError extends Error {
  readonly statusCode = 409;
  constructor(message = '品牌设置由上级平台统一管理，当前实例不可直接修改') {
    super(message);
    this.name = 'InstanceBrandingReadonlyError';
  }
}

const LIMITS = {
  site_name: 64,
  browser_title: 120,
  site_description: 255,
  keyword_count: 12,
  keyword_length: 40,
  login_heading: 160,
  login_subheading: 512,
  logo_bytes: 512 * 1024,
  favicon_bytes: 128 * 1024,
} as const;

function textField(value: unknown, field: string, fallback: string, max: number, required: boolean): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new InstanceBrandingValidationError(`${field} 必须是字符串`);
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (required && !normalized) throw new InstanceBrandingValidationError(`${field} 不能为空`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new InstanceBrandingValidationError(`${field} 包含不可见控制字符`);
  if (normalized.length > max) throw new InstanceBrandingValidationError(`${field} 最多 ${max} 个字符`);
  return normalized;
}

function keywordField(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new InstanceBrandingValidationError('site_keywords 必须是字符串数组');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') throw new InstanceBrandingValidationError('site_keywords 只能包含字符串');
    const keyword = item.replace(/\s+/g, ' ').trim();
    if (!keyword) continue;
    if (/[\u0000-\u001f\u007f]/.test(keyword)) throw new InstanceBrandingValidationError('site_keywords 包含不可见控制字符');
    if (keyword.length > LIMITS.keyword_length) {
      throw new InstanceBrandingValidationError(`单个关键词最多 ${LIMITS.keyword_length} 个字符`);
    }
    const key = keyword.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
  }
  if (out.length > LIMITS.keyword_count) {
    throw new InstanceBrandingValidationError(`关键词最多 ${LIMITS.keyword_count} 个`);
  }
  return out;
}

function hasPrefix(data: Buffer, bytes: number[]): boolean {
  return bytes.every((value, index) => data[index] === value);
}

function detectedImageType(data: Buffer): string | null {
  if (data.length >= 8 && hasPrefix(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (data.length >= 3 && hasPrefix(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (data.length >= 4 && hasPrefix(data, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  return null;
}

export function parseBrandingAssetDataUrl(value: unknown, kind: BrandingAssetKind): BrandingAsset | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new InstanceBrandingValidationError(`${kind} 必须是 data URL 或 null`);
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2]!.length % 4 !== 0) throw new InstanceBrandingValidationError(`${kind} 不是合法的 base64 data URL`);
  const data = Buffer.from(match[2]!, 'base64');
  if (!data.length) throw new InstanceBrandingValidationError(`${kind} 文件为空`);
  const detected = detectedImageType(data);
  const allowed = kind === 'logo'
    ? new Set(['image/png', 'image/jpeg', 'image/webp'])
    : new Set(['image/png', 'image/x-icon']);
  if (!detected || !allowed.has(detected)) {
    throw new InstanceBrandingValidationError(
      kind === 'logo' ? 'logo 仅支持 PNG、JPEG 或 WebP' : 'favicon 仅支持 PNG 或 ICO',
    );
  }
  const max = kind === 'logo' ? LIMITS.logo_bytes : LIMITS.favicon_bytes;
  if (data.length > max) throw new InstanceBrandingValidationError(`${kind} 文件不能超过 ${Math.floor(max / 1024)} KiB`);
  return { contentType: detected, data, revision: '' };
}

export function normalizeInstanceBrandingUpdate(
  input: InstanceBrandingUpdate,
  current: InstanceBrandingText,
): NormalizedInstanceBrandingUpdate {
  return {
    text: {
      site_name: textField(input.site_name, 'site_name', current.site_name, LIMITS.site_name, true),
      browser_title: textField(input.browser_title, 'browser_title', current.browser_title, LIMITS.browser_title, true),
      site_description: textField(input.site_description, 'site_description', current.site_description, LIMITS.site_description, false),
      site_keywords: keywordField(input.site_keywords, current.site_keywords),
      login_heading: textField(input.login_heading, 'login_heading', current.login_heading, LIMITS.login_heading, true),
      login_subheading: textField(input.login_subheading, 'login_subheading', current.login_subheading, LIMITS.login_subheading, false),
    },
    logo: parseBrandingAssetDataUrl(input.logo_data_url, 'logo'),
    favicon: parseBrandingAssetDataUrl(input.favicon_data_url, 'favicon'),
  };
}

export function defaultInstanceBrandingSnapshot(): InstanceBrandingSnapshot {
  return {
    ...DEFAULT_INSTANCE_BRANDING,
    site_keywords: [...DEFAULT_INSTANCE_BRANDING.site_keywords],
    has_logo: false,
    has_favicon: false,
    revision: 'default',
    updated_at: null,
  };
}

export function publicInstanceBranding(snapshot: InstanceBrandingSnapshot): InstanceBrandingPublicView {
  const version = encodeURIComponent(snapshot.revision);
  return {
    ...snapshot,
    site_keywords: [...snapshot.site_keywords],
    logo_url: snapshot.has_logo ? `/branding/logo?v=${version}` : null,
    favicon_url: snapshot.has_favicon ? `/favicon.ico?v=${version}` : null,
  };
}
