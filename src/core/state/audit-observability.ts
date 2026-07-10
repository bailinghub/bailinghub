import type { AuditEntry } from '../contracts/types';
import type { RuntimeStateStore } from './state-contracts';

export interface AuditFailureSnapshot {
  total: number;
  lastFailureAt: string | null;
}

export interface AuditFailureLogger {
  error(message: string): void;
}

/** 进程级审计写失败计数；审计账本本身不可用时不能再依赖审计账本告警。 */
export class AuditFailureTracker {
  private total = 0;
  private lastFailureAt: string | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  record(): AuditFailureSnapshot {
    this.total += 1;
    this.lastFailureAt = new Date(this.now()).toISOString();
    return this.snapshot();
  }

  snapshot(): AuditFailureSnapshot {
    return { total: this.total, lastFailureAt: this.lastFailureAt };
  }
}

/**
 * 在状态仓库边界统一观测 appendAudit 失败。
 * 失败仍会重新抛出：调用方可明确选择 fail-closed 或 best-effort，但两者都会留下运行日志和计数。
 */
export function observeAuditFailures(
  stateStore: RuntimeStateStore,
  tracker: AuditFailureTracker,
  logger: AuditFailureLogger = console,
): RuntimeStateStore {
  const appendAudit = async (entry: AuditEntry): Promise<void> => {
    try {
      await stateStore.appendAudit(entry);
    } catch (error) {
      const snapshot = tracker.record();
      logger.error(JSON.stringify({
        level: 'error',
        event: 'audit_write_failed',
        audit_event: entry.event,
        job_id: entry.job_id,
        request_id: entry.request_id,
        failure_count: snapshot.total,
        error: safeErrorMessage(error),
      }));
      throw error;
    }
  };

  return new Proxy(stateStore, {
    get(target, property) {
      if (property === 'appendAudit') return appendAudit;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/:\/\/([^:@/\s]+):([^@/\s]+)@/g, '://$1:[REDACTED]@')
    .replace(/\bauthorization\s*[=:]\s*[^\r\n,;]+/gi, 'authorization=[REDACTED]')
    .replace(/\b(password|token|secret|api[_-]?key|access[_-]?key)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .slice(0, 300);
}
