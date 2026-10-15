import { notificationBackgroundWorkFor } from './notification-background-work';

const wakes = new WeakMap<object, () => void | Promise<void>>();

/** A wake is only a latency hint; the persistent maintenance scan owns recovery. */
export function bindNotificationOutboxWake(store: object, wake: (() => void | Promise<void>) | null): void {
  if (wake) wakes.set(store, wake); else wakes.delete(store);
}

export function wakeNotificationOutboxFor(store: object): void {
  const wake = wakes.get(store);
  if (!wake) return;
  // Include the claim query itself in shutdown drain, not only the later send.
  void notificationBackgroundWorkFor(store).track('delivery', async () => { await wake(); }).catch(() => undefined);
}
