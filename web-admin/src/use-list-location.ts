import { computed, nextTick, watch, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { filterLocatedRows, readListLocation } from './console-location';
import { patchTaskQuery, queryText, safeTaskReturnPath } from './task-page-location';

export function useListLocation<T>(source: Ref<T[]>, options: { id: (row: T) => string; text: (row: T) => string; prefix?: string }) {
  const route = useRoute(), router = useRouter(), prefix = options.prefix || '';
  const state = computed(() => readListLocation(route.query, prefix));
  const keyword = computed({ get: () => state.value.keyword, set: (q: string) => { void router.replace({ query: patchTaskQuery(route.query, { [`${prefix}q`]: q.slice(0, 200) || undefined, [`${prefix}focus`]: undefined, [`${prefix}related`]: undefined }), hash: route.hash }); } });
  const focus = computed(() => state.value.focus);
  const relatedFocus = computed(() => focus.value ? queryText(route.query[`${prefix}related`]).slice(0, 200) : '');
  const rows = computed(() => filterLocatedRows(source.value, keyword.value, focus.value, options.id, options.text, relatedFocus.value));
  const returnTo = computed(() => safeTaskReturnPath(route.query.return_to));
  function clear() { void router.replace({ query: patchTaskQuery(route.query, { [`${prefix}q`]: undefined, [`${prefix}focus`]: undefined, [`${prefix}related`]: undefined }), hash: route.hash }); }
  // Scroll after the list has rendered, including when returning to another section on the same page.
  async function scrollToSection() {
    const hash = route.hash, path = route.path;
    if (!hash) return;
    await nextTick();
    requestAnimationFrame(() => { if (route.path === path && route.hash === hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' }); });
  }
  watch(() => route.hash, () => { void scrollToSection(); }, { immediate: true, flush: 'post' });
  return { keyword, focus, relatedFocus, rows, returnTo, clear, scrollToSection };
}
