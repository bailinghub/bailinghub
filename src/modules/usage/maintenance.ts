import { getBillingRepository } from './billing-repository';
import type { UsageRepository } from './repository';

const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 5 * 60_000;
interface MaintenanceState { flight: Promise<void> | null; retryAt: number; failures: number }
const owners = new WeakMap<UsageRepository, MaintenanceState>();

export function usageMaintenanceSnapshotFor(repository: UsageRepository, clock = performance.now()): {
  running: boolean; consecutiveFailures: number; retryAfterMs: number;
} {
  const state = owners.get(repository);
  return { running: Boolean(state?.flight), consecutiveFailures: state?.failures ?? 0,
    retryAfterMs: Math.max(0, (state?.retryAt ?? 0) - clock) };
}

/** Shared startup/tick/HTTP fallback port. No timer, credentials or provider transport. */
export function runUsageMaintenanceFor(repository: UsageRepository | null, clock: number | (() => number) = () => performance.now()): Promise<void> {
  if (!repository || !repository.backgroundWork.acceptingRequests) return Promise.resolve();
  const now = typeof clock === 'function' ? clock : () => clock;
  let state = owners.get(repository);
  if (!state) { state = { flight: null, retryAt: 0, failures: 0 }; owners.set(repository, state); }
  if (state.flight) return state.flight;
  if (now() < state.retryAt) return Promise.resolve();
  const owner = state, tokens = getBillingRepository(repository);
  const work = repository.backgroundWork.startMaintenance('usage-reconciliation', async () => {
    // Optional usage remains optional; initialize a Kernel without installing it.
    if (await tokens.ready()) await tokens.reconcilePendingUsage();
  });
  if (!work) return Promise.resolve();
  owner.flight = work.then(() => {
    owner.failures = 0; owner.retryAt = 0;
  }, () => {
    // The registry reports only the fixed work kind. No raw DB/provider error escapes.
    owner.failures = Math.min(owner.failures + 1, 4);
    owner.retryAt = now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (owner.failures - 1));
  }).finally(() => { owner.flight = null; });
  return owner.flight;
}
