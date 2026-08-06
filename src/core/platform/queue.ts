/** 简单的并发上限队列：超过并发数的任务排队，前面腾出槽位再跑。 */
export class Queue {
  private running = 0;
  private accepting = true;
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private drainWaiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    /**
     * 可选的宿主级并发闸。每个 Kernel 仍保留自己的本地队列与 drain 语义，
     * 只把真正执行的任务送进共享闸，避免关闭一个 Kernel 时等待其他租户的任务。
     */
    private readonly upstream?: Pick<Queue, 'run'>,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('queue concurrency must be a positive integer');
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (!this.accepting) throw new Error('queue is not accepting new work');
    let slotTransferred = false;
    if (this.running >= this.concurrency) {
      await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
      slotTransferred = true;
    }
    if (!slotTransferred) this.running++;
    try {
      return await (this.upstream ? this.upstream.run(task) : task());
    } finally {
      const next = this.waiters.shift();
      if (next) {
        // Hand the occupied slot directly to the next admitted waiter. This
        // avoids a transient running=0 window where drain() could return early.
        next.resolve();
      } else {
        this.running--;
        if (this.running === 0) this.notifyDrained();
      }
    }
  }

  /** Stop admission and reject work that has not acquired a local slot yet. */
  closeAdmission(): void {
    if (!this.accepting) return;
    this.accepting = false;
    const error = new Error('queue is closing');
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    if (this.running === 0) this.notifyDrained();
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
      const done = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.drainWaiters.push(done);
    });
  }

  private notifyDrained(): void {
    const drains = this.drainWaiters.splice(0);
    for (const drain of drains) drain();
  }
}
