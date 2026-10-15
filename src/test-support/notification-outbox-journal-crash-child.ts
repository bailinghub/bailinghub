import { JsonlStore } from '../infrastructure/state/state-jsonl';
import type { Job } from '../core/contracts/types';
import type { NotificationEvent } from '../core/contracts/notification-outbox';

process.once('message', async (input: { path: string; job: Job }) => {
  try {
    const store = new JsonlStore(input.path); await store.init(); await store.createJob(input.job);
    const privateStore = store as unknown as { persist(job: Job, events?: NotificationEvent[]): Promise<void> };
    const persist = privateStore.persist.bind(store);
    privateStore.persist = async (job, events) => {
      await persist(job, events); // Includes the real FileHandle.sync, not a fake storage acknowledgement.
      if (events?.length) await new Promise<void>(() => {
        process.send?.({ stage: 'after-sync-before-memory-publication', pid: process.pid }, () => process.kill(process.pid, 'SIGKILL'));
      });
    };
    await store.completeJobWithNotifications(input.job, { status: 'done', result: { text: 'synthetic committed' } });
  } catch {
    process.send?.({ error: 'synthetic_journal_worker_failed' }); process.exitCode = 1;
  }
});
