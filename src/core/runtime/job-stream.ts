export const CHAT_STREAM_PROTOCOL = 'bailing.chat.stream.v1' as const;

export type JobStreamPhaseName = 'model' | 'tool';
export type JobStreamResetReason = 'model_round' | 'tool_call' | 'retry' | 'fallback';

export type JobStreamEventInput =
  | { type: 'phase'; data: { name: JobStreamPhaseName; round: number } }
  | { type: 'reset'; data: { reason: JobStreamResetReason; round?: number } }
  | { type: 'delta'; data: { text: string; round: number } };

export type JobStreamEvent = JobStreamEventInput & {
  seq: number;
  ts: string;
};

export interface JobStreamReadResult {
  events: JobStreamEvent[];
  /** true 表示调用方的游标早于当前回放窗口，必须清空临时展示后再消费返回事件。 */
  truncated: boolean;
  latestSeq: number;
}

export interface JobStreamBroker {
  publish(jobId: string, event: JobStreamEventInput): JobStreamEvent;
  read(jobId: string, afterSeq?: number): JobStreamReadResult;
  waitFor(jobId: string, afterSeq: number, timeoutMs: number): Promise<void>;
  seal(jobId: string): void;
}

export interface InMemoryJobStreamOptions {
  maxEventsPerJob?: number;
  maxBytesPerJob?: number;
  maxJobs?: number;
  ttlMs?: number;
  now?: () => number;
}

interface JobStreamState {
  events: JobStreamEvent[];
  bytes: number;
  nextSeq: number;
  droppedThrough: number;
  updatedAt: number;
  sealed: boolean;
  waiters: Set<() => void>;
}

const DEFAULT_MAX_EVENTS_PER_JOB = 512;
const DEFAULT_MAX_BYTES_PER_JOB = 512 * 1024;
const DEFAULT_MAX_JOBS = 1_000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function eventBytes(event: JobStreamEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}

/**
 * 单进程默认实现。事件只用于短期传输和断线回放，不进入任务结果、会话总账或审计库。
 * 多副本部署应注入共享实现，或为同一 job 的 POST/SSE 请求启用粘性路由。
 */
export class InMemoryJobStreamBroker implements JobStreamBroker {
  private readonly streams = new Map<string, JobStreamState>();
  private readonly maxEventsPerJob: number;
  private readonly maxBytesPerJob: number;
  private readonly maxJobs: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: InMemoryJobStreamOptions = {}) {
    this.maxEventsPerJob = positiveInt(options.maxEventsPerJob, DEFAULT_MAX_EVENTS_PER_JOB);
    this.maxBytesPerJob = positiveInt(options.maxBytesPerJob, DEFAULT_MAX_BYTES_PER_JOB);
    this.maxJobs = positiveInt(options.maxJobs, DEFAULT_MAX_JOBS);
    this.ttlMs = positiveInt(options.ttlMs, DEFAULT_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  publish(jobId: string, input: JobStreamEventInput): JobStreamEvent {
    const key = this.jobKey(jobId);
    this.prune();
    const state = this.stateForWrite(key);
    const event = {
      ...input,
      seq: state.nextSeq++,
      ts: new Date(this.now()).toISOString(),
    } as JobStreamEvent;
    const bytes = eventBytes(event);
    state.events.push(event);
    state.bytes += bytes;
    state.updatedAt = this.now();
    state.sealed = false;

    while (state.events.length > 1 && (state.events.length > this.maxEventsPerJob || state.bytes > this.maxBytesPerJob)) {
      const dropped = state.events.shift()!;
      state.bytes -= eventBytes(dropped);
      state.droppedThrough = dropped.seq;
    }
    this.wake(state);
    return event;
  }

  read(jobId: string, afterSeq = 0): JobStreamReadResult {
    this.prune();
    const state = this.streams.get(this.jobKey(jobId));
    if (!state) return { events: [], truncated: false, latestSeq: 0 };
    const cursor = Number.isSafeInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
    state.updatedAt = this.now();
    return {
      events: state.events.filter((event) => event.seq > cursor),
      truncated: cursor < state.droppedThrough,
      latestSeq: state.nextSeq - 1,
    };
  }

  async waitFor(jobId: string, afterSeq: number, timeoutMs: number): Promise<void> {
    this.prune();
    const state = this.streams.get(this.jobKey(jobId));
    if (!state || state.sealed || state.nextSeq - 1 > afterSeq || timeoutMs <= 0) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      state.waiters.add(done);
    });
  }

  seal(jobId: string): void {
    this.prune();
    const state = this.streams.get(this.jobKey(jobId));
    if (!state) return;
    state.sealed = true;
    state.updatedAt = this.now();
    this.wake(state);
  }

  private jobKey(jobId: string): string {
    const key = String(jobId ?? '').trim();
    if (!key) throw new Error('job stream requires a non-empty job id');
    return key;
  }

  private stateForWrite(jobId: string): JobStreamState {
    const existing = this.streams.get(jobId);
    if (existing) return existing;
    if (this.streams.size >= this.maxJobs) {
      const oldest = [...this.streams.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (oldest) this.deleteState(oldest[0], oldest[1]);
    }
    const state: JobStreamState = {
      events: [],
      bytes: 0,
      nextSeq: 1,
      droppedThrough: 0,
      updatedAt: this.now(),
      sealed: false,
      waiters: new Set(),
    };
    this.streams.set(jobId, state);
    return state;
  }

  private prune(): void {
    const expiresBefore = this.now() - this.ttlMs;
    for (const [jobId, state] of this.streams) {
      if (state.updatedAt < expiresBefore) this.deleteState(jobId, state);
    }
  }

  private deleteState(jobId: string, state: JobStreamState): void {
    this.streams.delete(jobId);
    this.wake(state);
  }

  private wake(state: JobStreamState): void {
    for (const waiter of [...state.waiters]) waiter();
  }
}
