/** Stable snapshots contain form values only; never persist them to browser storage. */
export function formSnapshot(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

export interface FormGuardState {
  active(): boolean;
  dirty(): boolean;
  saving(): boolean;
}

export function needsUnloadWarning(state: FormGuardState): boolean {
  return state.active() && (state.dirty() || state.saving());
}

/** One decision shared by X, Esc, mask, cancel and router navigation. */
export function createFormExitGuard(state: FormGuardState, confirmDiscard: () => Promise<boolean>, notifySaving: () => void) {
  let pending: Promise<boolean> | undefined;
  function confirmLeave(): Promise<boolean> {
    if (!state.active()) return Promise.resolve(true);
    if (state.saving()) { notifySaving(); return Promise.resolve(false); }
    if (!state.dirty()) return Promise.resolve(true);
    if (!pending) pending = (async () => {
      try {
        if (!await confirmDiscard()) return false;
        // Saving may have started while a leave confirmation was open.
        if (state.saving()) { notifySaving(); return false; }
        return true;
      } catch { return false; }
    })().finally(() => { pending = undefined; });
    return pending;
  }
  return { confirmLeave };
}
