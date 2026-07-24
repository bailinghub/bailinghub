import { createHash, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../core/config/config';
import {
  renderOperationalMetrics,
  type CollectorResult,
  type ControlPlaneOperationalMetricsSnapshot,
} from '../core/observability/openmetrics';
import { buildVersionInfo } from '../core/platform/version';
import type { AuditFailureTracker } from '../core/state/audit-observability';
import type { JobOperationalMetricsSnapshot, RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export interface OperationalMetricsEndpoint {
  readonly enabled: boolean;
  authorize(authorization: string | string[] | undefined): boolean;
  scrape(): Promise<string>;
}

export interface OperationalMetricsDeps {
  cfg: Pick<AppConfig, 'root' | 'metrics'>;
  store: RuntimeStateStore;
  configStore: ConfigStoreContract | null;
  queue: { stats(): { running: number; waiting: number } };
  isPaused(): boolean;
  auditFailures: Pick<AuditFailureTracker, 'snapshot'>;
  logger?: Pick<Console, 'error'>;
  now?: () => number;
  build?: { version: string; commit: string };
}

class CollectorTimeoutError extends Error {}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function bearerToken(authorization: string | string[] | undefined): string {
  if (typeof authorization !== 'string') return '';
  const match = authorization.match(/^Bearer[ \t]+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

function buildIdentity(root: string): { version: string; commit: string } {
  const info = buildVersionInfo(root);
  const app = info.app && typeof info.app === 'object' ? info.app as Record<string, unknown> : {};
  const build = info.build && typeof info.build === 'object' ? info.build as Record<string, unknown> : {};
  return {
    version: typeof app.version === 'string' ? app.version : 'unknown',
    commit: typeof build.commit === 'string' && build.commit ? build.commit : 'unknown',
  };
}

async function collect<T>(
  collector: 'state' | 'control_plane',
  action: (() => Promise<T>) | undefined,
  timeoutMs: number,
  logger: Pick<Console, 'error'>,
): Promise<CollectorResult<T>> {
  if (!action) return { available: false, success: false };
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CollectorTimeoutError()), timeoutMs);
    });
    const value = await Promise.race([action(), timeout]);
    return { available: true, success: true, value };
  } catch (error) {
    logger.error(JSON.stringify({
      level: 'error',
      event: 'metrics_collector_failed',
      collector,
      failure: error instanceof CollectorTimeoutError ? 'timeout' : 'error',
    }));
    return { available: true, success: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createOperationalMetricsEndpointFor(deps: OperationalMetricsDeps): OperationalMetricsEndpoint {
  const logger = deps.logger ?? console;
  const now = deps.now ?? Date.now;
  const build = deps.build ?? buildIdentity(deps.cfg.root);
  const expectedTokenDigest = digest(deps.cfg.metrics.token);
  const stateCollector = deps.store.operationalMetricsSnapshot?.bind(deps.store);
  const controlPlaneCollector = deps.configStore?.observability.operationalMetricsSnapshot?.bind(deps.configStore.observability);

  return {
    enabled: deps.cfg.metrics.enabled,
    authorize(authorization): boolean {
      const actualTokenDigest = digest(bearerToken(authorization));
      return deps.cfg.metrics.enabled
        && deps.cfg.metrics.token.length > 0
        && timingSafeEqual(actualTokenDigest, expectedTokenDigest);
    },
    async scrape(): Promise<string> {
      const startedAt = now();
      const snapshotAt = now();
      const [state, controlPlane] = await Promise.all([
        collect<JobOperationalMetricsSnapshot>(
          'state',
          stateCollector ? () => stateCollector(snapshotAt) : undefined,
          deps.cfg.metrics.scrapeTimeoutMs,
          logger,
        ),
        collect<ControlPlaneOperationalMetricsSnapshot>(
          'control_plane',
          controlPlaneCollector ? () => controlPlaneCollector(snapshotAt) : undefined,
          deps.cfg.metrics.scrapeTimeoutMs,
          logger,
        ),
      ]);
      return renderOperationalMetrics({
        ...build,
        paused: deps.isPaused(),
        queue: deps.queue.stats(),
        state,
        controlPlane,
        auditWriteFailuresTotal: deps.auditFailures.snapshot().total,
        scrapeDurationSeconds: Math.max((now() - startedAt) / 1000, 0),
      });
    },
  };
}
