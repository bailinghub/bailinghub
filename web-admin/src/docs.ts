const OFFICIAL_DOCS_ORIGIN = 'https://www.bailinghub.com';

function docsOrigin(): string {
  const configured = String(import.meta.env.VITE_BAILING_DOCS_BASE_URL ?? '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return OFFICIAL_DOCS_ORIGIN;
}

export function docUrl(path = '/docs'): string {
  const normalized = path.startsWith('/docs') ? path : `/docs${path.startsWith('#') ? '' : '/'}${path}`;
  return `${docsOrigin()}${normalized}`;
}

export function openDoc(path = '/docs'): void {
  window.open(docUrl(path), '_blank', 'noopener,noreferrer');
}
