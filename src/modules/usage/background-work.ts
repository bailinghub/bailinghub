export type UsageBackgroundKind = 'model-completion' | 'settlement' | 'response-cleanup' | 'usage-reconciliation' | 'reference-price-refresh';
type MaintenanceKind = Exclude<UsageBackgroundKind, 'model-completion' | 'settlement'>;

/** One UsageRepository owns its accepted work, including children created during drain. */
export class UsageBackgroundWork {
  private readonly pending = new Set<Promise<unknown>>();
  private draining = false;
  private failureReporter: ((kind: UsageBackgroundKind) => void) | undefined;

  get acceptingRequests(): boolean { return !this.draining; }
  setFailureReporter(reporter: (kind: UsageBackgroundKind) => void): void { this.failureReporter = reporter; }
  beginDrain(): void { this.draining = true; }

  track<T>(kind: UsageBackgroundKind, run: () => Promise<T>): Promise<T> {
    // Register before invoking run: even an immediately resolving parent must not
    // leave a gap before its SQL/settlement continuation has been registered.
    const work = Promise.resolve().then(run);
    this.pending.add(work);
    void work.then(() => { this.pending.delete(work); }, () => {
      this.pending.delete(work);
      // Report only the fixed work kind; provider bodies, SQL and credentials
      // are never included in lifecycle diagnostics.
      try { this.failureReporter?.(kind); } catch { /* diagnostics cannot own lifecycle */ }
    });
    return work;
  }

  startMaintenance<T>(kind: MaintenanceKind, run: () => Promise<T>): Promise<T> | null {
    return this.draining ? null : this.track(kind, run);
  }

  async drain(drainMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, drainMs);
    while (this.pending.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drained = await Promise.race([
          Promise.allSettled([...this.pending]).then(() => true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), remaining); }),
        ]);
        if (!drained) return false;
      } finally { if (timer) clearTimeout(timer); }
      // A tracked completion can register settlement after drain started. Do
      // not mistake a finished snapshot for a quiescent repository.
    }
    return true;
  }
}
