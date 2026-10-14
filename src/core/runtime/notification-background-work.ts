export const NOTIFICATION_BACKGROUND_KINDS = ['callback', 'delivery', 'approval-notification', 'alert', 'delivery-dlq'] as const;
export type NotificationBackgroundKind = typeof NOTIFICATION_BACKGROUND_KINDS[number];

export interface NotificationBackgroundKindSnapshot {
  kind: NotificationBackgroundKind;
  inFlight: number;
  completed: number;
  failed: number;
  oldestPendingAgeMs: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastFailedAt: string | null;
}

export interface NotificationBackgroundSnapshot {
  draining: boolean;
  drainTimeouts: number;
  kinds: NotificationBackgroundKindSnapshot[];
}

/** One Kernel owns its accepted notifications, including children registered during drain. */
export class NotificationBackgroundWork {
  private readonly pending = new Map<Promise<unknown>, { kind: NotificationBackgroundKind; startedAt: number }>();
  private readonly counters = new Map(NOTIFICATION_BACKGROUND_KINDS.map(kind => [kind, {
    completed: 0, failed: 0, lastStartedAt: null as string | null,
    lastCompletedAt: null as string | null, lastFailedAt: null as string | null,
  }]));
  private draining = false;
  private drainTimeouts = 0;
  private failureReporter: ((kind: NotificationBackgroundKind) => void) | undefined;

  setFailureReporter(reporter: (kind: NotificationBackgroundKind) => void): void { this.failureReporter = reporter; }
  beginDrain(): void { this.draining = true; }

  track<T>(kind: NotificationBackgroundKind, run: () => Promise<T>, failed?: (value: T) => boolean): Promise<T> {
    // Register before run, and allow accepted continuations to register children
    // after beginDrain. Kernel admission, not this tracker, stops new producers.
    const startedAt = Date.now();
    const counters = this.counters.get(kind)!;
    counters.lastStartedAt = new Date(startedAt).toISOString();
    const work = Promise.resolve().then(run);
    this.pending.set(work, { kind, startedAt });
    const finish = (isFailure: boolean) => {
      this.pending.delete(work);
      if (isFailure) {
        counters.failed++;
        counters.lastFailedAt = new Date().toISOString();
        try { this.failureReporter?.(kind); } catch { /* diagnostic only */ }
      } else {
        counters.completed++;
        counters.lastCompletedAt = new Date().toISOString();
      }
    };
    // Attach a rejection handler immediately so detached callers cannot leak an
    // unhandled rejection; awaited callers still receive the original rejection.
    void work.then(value => {
      let isFailure = false;
      try { isFailure = failed?.(value) ?? false; } catch { isFailure = true; }
      finish(isFailure);
    }, () => finish(true));
    return work;
  }

  snapshot(now = Date.now()): NotificationBackgroundSnapshot {
    return { draining: this.draining, drainTimeouts: this.drainTimeouts,
      kinds: NOTIFICATION_BACKGROUND_KINDS.map(kind => {
        let inFlight = 0, oldestStartedAt = now;
        for (const work of this.pending.values()) if (work.kind === kind) {
          inFlight++; oldestStartedAt = Math.min(oldestStartedAt, work.startedAt);
        }
        return { kind, ...this.counters.get(kind)!, inFlight,
          oldestPendingAgeMs: inFlight ? Math.max(0, now - oldestStartedAt) : 0 };
      }) };
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
      // Recheck the live set: finishing work can register later SQL or webhook work.
    }
    return true;
  }
}

const workByStore = new WeakMap<object, NotificationBackgroundWork>();
export function bindNotificationBackgroundWork(store: object, work: NotificationBackgroundWork): void { workByStore.set(store, work); }
export function notificationBackgroundWorkFor(store: object): NotificationBackgroundWork {
  let work = workByStore.get(store);
  if (!work) { work = new NotificationBackgroundWork(); workByStore.set(store, work); }
  return work;
}
