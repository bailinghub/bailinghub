import { randomUUID } from 'node:crypto';

// 按 key 串行执行的轻量链：同一 key 的任务 FIFO 串行、互不重叠；不同 key 各自的链互不阻塞、全并发。
// 用于会话(thread)级串行——同会话连发的消息一条接一条处理（后一条能看到前一条的回复、回复不乱序），
// 不同会话仍全并行。默认只做进程内 FIFO；传入 lease 后再叠加跨实例短租约互斥。
const lanes = new Map<string | number, Promise<unknown>>();

export interface SerialLease {
  acquireRuntimeLock(lockKey: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseRuntimeLock(lockKey: string, owner: string): Promise<void>;
}

export interface RunSerialOptions {
  lease?: SerialLease;
  owner?: string;
  ttlMs?: number;
  retryDelayMs?: number;
  maxWaitMs?: number;
}

const DEFAULT_TTL_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_WAIT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withLease<T>(key: string | number, task: () => Promise<T>, opts: RunSerialOptions): Promise<T> {
  if (!opts.lease) return task();
  const lease = opts.lease;
  const owner = opts.owner ?? `serial:${process.pid}:${randomUUID()}`;
  const lockKey = `serial:${String(key)}`;
  const ttlMs = Math.max(1, opts.ttlMs ?? DEFAULT_TTL_MS);
  const retryDelayMs = Math.max(1, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const deadline = Date.now() + Math.max(1, opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);

  for (;;) {
    if (await lease.acquireRuntimeLock(lockKey, owner, ttlMs)) break;
    const leftMs = deadline - Date.now();
    if (leftMs <= 0) throw new Error(`serial lock timeout: ${lockKey}`);
    await sleep(Math.min(retryDelayMs, leftMs));
  }

  const renewEveryMs = Math.max(1_000, Math.floor(ttlMs / 3));
  const renewTimer = setInterval(() => {
    void lease.acquireRuntimeLock(lockKey, owner, ttlMs).catch(() => undefined);
  }, renewEveryMs);
  renewTimer.unref?.();
  try {
    return await task();
  } finally {
    clearInterval(renewTimer);
    await lease.releaseRuntimeLock(lockKey, owner).catch(() => undefined);
  }
}

export function runSerial<T>(key: string | number | undefined, task: () => Promise<T>, opts: RunSerialOptions = {}): Promise<T> {
  if (key === undefined) return task(); // 无 key → 无串行需求，直接跑
  const base = (lanes.get(key) ?? Promise.resolve()).catch(() => undefined); // 前一棒失败也不卡后一棒
  const next = base.then(() => withLease(key, task, opts));
  lanes.set(key, next);
  // 链尾跑完即从表里摘除（仅当自己仍是当前链尾），防 Map 无界增长
  void next.catch(() => undefined).finally(() => { if (lanes.get(key) === next) lanes.delete(key); });
  return next;
}
