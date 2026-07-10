// 统一请求层：同源 Cookie 鉴权；401 → 登录页；错误透传后端 error 原文（DESIGN.md §8）
import { router } from './router';

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined) };
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const r = await fetch(path, { ...opts, headers });
  if (r.status === 401) {
    void router.push('/login');
    throw new Error('请先登录');
  }
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}
