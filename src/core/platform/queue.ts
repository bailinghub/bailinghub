/** 简单的并发上限队列：超过并发数的任务排队，前面腾出槽位再跑。 */
export class Queue {
  private running = 0;
  private waiters: Array<() => void> = [];
  private drainWaiters: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      await new Promise<void>((res) => this.waiters.push(res));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      const next = this.waiters.shift();
      if (next) {
        next();
      } else if (this.running === 0) {
        const drains = this.drainWaiters.splice(0);
        for (const drain of drains) drain();
      }
    }
  }

  stats(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiters.length };
  }

  async drain(timeoutMs: number): Promise<boolean> {
    if (this.running === 0 && this.waiters.length === 0) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.drainWaiters.indexOf(done);
        if (idx >= 0) this.drainWaiters.splice(idx, 1);
        resolve(false);
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      const done = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.drainWaiters.push(done);
    });
  }
}
