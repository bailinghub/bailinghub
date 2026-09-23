import { ref } from 'vue';
import { api } from './request';

export interface UsageDeletionReport {
  kind: 'plan' | 'issuer' | 'account';
  id: string;
  label: string;
  revision: number;
  can_delete: boolean;
  blockers: Array<{ code: string; message: string; count: number }>;
  effect: string;
}
export function useUsageDeletion(describe: (error: unknown) => string) {
  const open = ref(false), loading = ref(false), error = ref('');
  const path = ref(''), label = ref('');
  const report = ref<UsageDeletionReport | null>(null);
  let sequence = 0;
  async function refresh() {
    const current = ++sequence;
    const target = path.value;
    loading.value = true;
    error.value = '';
    report.value = null;
    try {
      const result = await api<UsageDeletionReport>(`${target}/deletion-preview`);
      if (current === sequence) report.value = result;
    } catch (e) {
      if (current === sequence) error.value = describe(e);
    } finally {
      if (current === sequence) loading.value = false;
    }
  }
  async function show(target: string, name: string) {
    path.value = target;
    label.value = name;
    open.value = true;
    await refresh();
  }
  return { open, loading, error, path, label, report, refresh, show };
}
