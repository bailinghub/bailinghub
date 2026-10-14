import type { BackgroundWorkMetricsSnapshot } from '../../core/observability/openmetrics';

export const USAGE_BACKGROUND_KINDS = ['model-completion', 'settlement', 'response-cleanup', 'usage-reconciliation', 'reference-price-refresh'] as const;
export type UsageBackgroundKind = typeof USAGE_BACKGROUND_KINDS[number];
type MaintenanceKind = Exclude<UsageBackgroundKind, 'model-completion' | 'settlement'>;

/** One UsageRepository owns its accepted work, including children created during drain. */
export class UsageBackgroundWork {
  private readonly pending = new Map<Promise<unknown>, { kind: UsageBackgroundKind; startedAt: number }>();
  private readonly counts = new Map(USAGE_BACKGROUND_KINDS.map(kind => [kind, {
    completed: 0, failed: 0,
    lastStartedAt: null as string | null, lastCompletedAt: null as string | null, lastFailedAt: null as string | null,
  }]));
  private draining = false;
  private drainTimeouts = 0;
  private failureReporter: ((kind: UsageBackgroundKind) => void) | undefined;

  constructor(private readonly clock: () => number = Date.now) {}

  get acceptingRequests(): boolean { return !this.draining; }
  setFailureReporter(reporter: (kind: UsageBackgroundKind) => void): void { this.failureReporter = reporter; }
  beginDrain(): void { this.draining = true; }

  /** Process-local fixed-kind values only; snapshots never start work or access SQL. */
  snapshot(nowMs = this.clock()): BackgroundWorkMetricsSnapshot {
    const live = new Map(USAGE_BACKGROUND_KINDS.map(kind => [kind, { count: 0, oldest: Infinity }]));
    for (const work of this.pending.values()) {
      const value = live.get(work.kind)!;
      value.count++; value.oldest = Math.min(value.oldest, work.startedAt);
    }
    return {
      draining: this.draining,
      drainTimeouts: this.drainTimeouts,
      kinds: USAGE_BACKGROUND_KINDS.map(kind => {
        const value = live.get(kind)!;
        return { kind, ...this.counts.get(kind)!, inFlight: value.count,
          oldestPendingAgeMs: value.count ? Math.max(0, nowMs - value.oldest) : 0 };
      }),
    };
  }

  track<T>(kind: UsageBackgroundKind, run: () => Promise<T>): Promise<T> {
    // Register before invoking run: even an immediately resolving parent must not
    // leave a gap before its SQL/settlement continuation has been registered.
    const work = Promise.resolve().then(run);
    const startedAt = this.clock(), counts = this.counts.get(kind)!;
    this.pending.set(work, { kind, startedAt });
    counts.lastStartedAt = new Date(startedAt).toISOString();
    void work.then(() => {
      this.pending.delete(work);
      counts.completed++;
      counts.lastCompletedAt = new Date(this.clock()).toISOString();
    }, () => {
      this.pending.delete(work);
      counts.failed++;
      counts.lastFailedAt = new Date(this.clock()).toISOString();
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
      if (remaining <= 0) { this.drainTimeouts++; return false; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drained = await Promise.race([
          Promise.allSettled([...this.pending.keys()]).then(() => true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), remaining); }),
        ]);
        if (!drained) { this.drainTimeouts++; return false; }
      } finally { if (timer) clearTimeout(timer); }
      // A tracked completion can register settlement after drain started. Do
      // not mistake a finished snapshot for a quiescent repository.
    }
    return true;
  }
}
