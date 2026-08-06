/**
 * The Core console remains a single build artifact. An embedding Kernel may
 * inject a trusted same-origin mount path into index.html at serve time.
 */
export function kernelMountPath(): string {
  const raw = document.head.querySelector<HTMLMetaElement>('meta[name="bailing-kernel-mount"]')?.content.trim() ?? '';
  if (!raw) return '';
  if (!/^\/(?:[a-zA-Z0-9._~-]|%[0-9A-Fa-f]{2})+(?:\/(?:[a-zA-Z0-9._~-]|%[0-9A-Fa-f]{2})+)*$/.test(raw)) return '';
  return raw;
}

export function kernelPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  return `${kernelMountPath()}${path}`;
}

export function kernelConsoleBase(): string {
  return `${kernelMountPath()}/console/`;
}

export function kernelOrigin(): string {
  return `${window.location.origin}${kernelMountPath()}`;
}

export function kernelFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(kernelPath(input), init);
}
