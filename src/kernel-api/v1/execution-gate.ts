import { Queue } from '../../core/platform/queue';
import type { KernelExecutionGateV1 } from './contracts';

/**
 * Public process-wide concurrency gate. It intentionally exposes only run();
 * each Kernel owns its local admission, statistics and drain lifecycle.
 */
export class KernelExecutionQueueV1 implements KernelExecutionGateV1 {
  readonly #queue: Queue;

  constructor(concurrency: number, upstream?: KernelExecutionGateV1) {
    this.#queue = new Queue(concurrency, upstream);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    return await this.#queue.run(task);
  }
}
