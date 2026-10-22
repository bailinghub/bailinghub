import { computed, onMounted, onUnmounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import { createFormExitGuard, formSnapshot, needsUnloadWarning } from './form-guard';

export function useUnsavedForm(options: { active(): boolean; saving(): boolean; snapshot(): unknown; name: string; retainedDraft?(): boolean }) {
  const baseline = ref('');
  const dirty = computed(() => options.active() && baseline.value !== formSnapshot(options.snapshot()));
  const state = { active: options.active, saving: options.saving, dirty: () => dirty.value };
  let preservingDraft = false;
  const guard = createFormExitGuard(state, async () => {
    try {
      await ElMessageBox.confirm(`${options.name}有未保存的修改，离开会放弃这些修改。`, '放弃未保存修改？', {
        confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning', distinguishCancelAndClose: true,
      });
      return true;
    } catch { return false; }
  }, () => ElMessage.warning('正在保存，请等待本次请求完成后再离开。'));
  function begin(savedBaseline?: string): void { baseline.value = savedBaseline ?? formSnapshot(options.snapshot()); }
  function markSaved(): void { begin(); }
  async function beforeClose(done: () => void): Promise<void> { if (await guard.confirmLeave()) done(); }
  function beforeUnload(event: BeforeUnloadEvent): void {
    if (!needsUnloadWarning(state) && !options.retainedDraft?.()) return;
    event.preventDefault(); event.returnValue = '';
  }
  // Only an explicit dependency detour may bypass the prompt, after its caller
  // has retained the draft in memory. Refresh/closing the browser still warns.
  async function withPreservedDraft<T>(navigate: () => Promise<T>): Promise<T | undefined> {
    if (options.saving()) return undefined;
    preservingDraft = true;
    try { return await navigate(); } finally { preservingDraft = false; }
  }
  onBeforeRouteLeave(() => preservingDraft ? true : guard.confirmLeave());
  onMounted(() => window.addEventListener('beforeunload', beforeUnload));
  onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload));
  return { dirty, baseline, begin, markSaved, beforeClose, confirmLeave: guard.confirmLeave, withPreservedDraft };
}
