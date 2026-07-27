import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INSTANCE_BRANDING,
  InstanceBrandingValidationError,
  defaultInstanceBrandingSnapshot,
  normalizeInstanceBrandingUpdate,
  parseBrandingAssetDataUrl,
  publicInstanceBranding,
} from './instance-branding';

function dataUrl(contentType: string, bytes: number[]): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
}

test('instance branding: partial update keeps current fields and normalizes keywords', () => {
  const current = {
    ...DEFAULT_INSTANCE_BRANDING,
    site_keywords: [...DEFAULT_INSTANCE_BRANDING.site_keywords],
  };
  const result = normalizeInstanceBrandingUpdate({
    site_name: '  Example   Control Plane ',
    site_keywords: ['Agent', ' agent ', '', 'Governance'],
  }, current);

  assert.equal(result.text.site_name, 'Example Control Plane');
  assert.equal(result.text.browser_title, current.browser_title);
  assert.deepEqual(result.text.site_keywords, ['Agent', 'Governance']);
  assert.equal(result.logo, undefined);
  assert.equal(result.favicon, undefined);
});

test('instance branding: image assets are accepted by detected bytes rather than claimed MIME', () => {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const logo = parseBrandingAssetDataUrl(dataUrl('application/octet-stream', png), 'logo');
  const favicon = parseBrandingAssetDataUrl(dataUrl('image/jpeg', png), 'favicon');

  assert.equal(logo?.contentType, 'image/png');
  assert.equal(favicon?.contentType, 'image/png');
});

test('instance branding: executable or unsupported image payloads are rejected', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.throws(
    () => parseBrandingAssetDataUrl(`data:image/svg+xml;base64,${svg.toString('base64')}`, 'logo'),
    InstanceBrandingValidationError,
  );
  assert.throws(
    () => parseBrandingAssetDataUrl(dataUrl('image/x-icon', [0x00, 0x00, 0x01, 0x00]), 'logo'),
    /logo 仅支持/,
  );
});

test('instance branding: public view only exposes stable asset URLs', () => {
  const view = publicInstanceBranding({
    ...defaultInstanceBrandingSnapshot(),
    has_logo: true,
    has_favicon: true,
    revision: 'rev/1',
  });

  assert.equal(view.logo_url, '/branding/logo?v=rev%2F1');
  assert.equal(view.favicon_url, '/favicon.ico?v=rev%2F1');
  assert.equal('management_url' in view, false);
});
