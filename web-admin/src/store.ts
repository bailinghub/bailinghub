import { defineStore } from 'pinia';
import { kernelFetch } from './runtime-path';

export interface Me {
  username: string;
  via: string;
  role: string;
  perms: string[];
  capabilities?: { modules?: string[] };
}

export const useMe = defineStore('me', {
  state: () => ({ me: null as Me | null, fetched: false }),
  getters: { perms: (s) => s.me?.perms ?? [] },
  actions: {
    can(perm: string): boolean {
      return this.perms.includes('*') || this.perms.includes(perm);
    },
    hasModule(module: string): boolean {
      const modules = this.me?.capabilities?.modules;
      return !Array.isArray(modules) || modules.includes(module);
    },
    async fetch(): Promise<Me | null> {
      this.fetched = true;
      const r = await kernelFetch('/admin/api/me');
      if (!r.ok) { this.me = null; return null; }
      this.me = (await r.json()) as Me;
      return this.me;
    },
    async logout(): Promise<void> {
      await kernelFetch('/admin/logout', { method: 'POST' }).catch(() => undefined);
      this.me = null;
    },
  },
});
