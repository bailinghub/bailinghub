import { defineStore } from 'pinia';

export interface Me { username: string; via: string; role: string; perms: string[] }

export const useMe = defineStore('me', {
  state: () => ({ me: null as Me | null, fetched: false }),
  getters: { perms: (s) => s.me?.perms ?? [] },
  actions: {
    can(perm: string): boolean {
      return this.perms.includes('*') || this.perms.includes(perm);
    },
    async fetch(): Promise<Me | null> {
      this.fetched = true;
      const r = await fetch('/admin/api/me');
      if (!r.ok) { this.me = null; return null; }
      this.me = (await r.json()) as Me;
      return this.me;
    },
    async logout(): Promise<void> {
      await fetch('/admin/logout', { method: 'POST' }).catch(() => undefined);
      this.me = null;
    },
  },
});
