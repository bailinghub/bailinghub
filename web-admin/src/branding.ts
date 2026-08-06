import { reactive } from 'vue';
import { kernelFetch, kernelPath } from './runtime-path';

export interface InstanceBranding {
  site_name: string;
  browser_title: string;
  site_description: string;
  site_keywords: string[];
  login_heading: string;
  login_subheading: string;
  has_logo: boolean;
  has_favicon: boolean;
  logo_url: string | null;
  favicon_url: string | null;
  revision: string;
  updated_at: string | null;
}

export const DEFAULT_BRANDING: InstanceBranding = {
  site_name: '百灵中枢',
  browser_title: '百灵中枢 · 控制台',
  site_description: '开源、自托管的 Agent 业务动作治理控制面',
  site_keywords: ['Agent 治理', 'AI 控制面', 'BailingHub'],
  login_heading: '把业务系统接成可治理的 AI 操作入口',
  login_subheading: '从触发路由、工具声明、审批意图到审计追溯，所有运行痕迹留在自己的控制台里。',
  has_logo: false,
  has_favicon: false,
  logo_url: null,
  favicon_url: null,
  revision: 'default',
  updated_at: null,
};

export const instanceBranding = reactive<InstanceBranding>({
  ...DEFAULT_BRANDING,
  site_keywords: [...DEFAULT_BRANDING.site_keywords],
});

function upsertMeta(name: string, content: string): void {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!content) {
    element?.remove();
    return;
  }
  if (!element) {
    element = document.createElement('meta');
    element.name = name;
    document.head.appendChild(element);
  }
  element.content = content;
}

function applyDocumentMetadata(): void {
  document.title = instanceBranding.browser_title || DEFAULT_BRANDING.browser_title;
  upsertMeta('description', instanceBranding.site_description);
  upsertMeta('keywords', instanceBranding.site_keywords.join(', '));

  const id = 'bailing-instance-favicon';
  let favicon = document.head.querySelector<HTMLLinkElement>(`#${id}`);
  if (!instanceBranding.favicon_url) {
    favicon?.remove();
    return;
  }
  if (!favicon) {
    favicon = document.createElement('link');
    favicon.id = id;
    favicon.rel = 'icon';
    document.head.appendChild(favicon);
  }
  favicon.href = kernelPath(instanceBranding.favicon_url);
}

export function setInstanceBranding(value: InstanceBranding): void {
  Object.assign(instanceBranding, value, { site_keywords: [...(value.site_keywords ?? [])] });
  applyDocumentMetadata();
}

export async function loadInstanceBranding(): Promise<void> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 2500);
  try {
    const response = await kernelFetch('/branding', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return;
    setInstanceBranding(await response.json() as InstanceBranding);
  } catch {
    applyDocumentMetadata();
  } finally {
    window.clearTimeout(timer);
  }
}
