/** Test-only process entrypoint. Configuration arrives over IPC, never from a deployment file. */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PoolConnection } from 'mysql2/promise';
import type { AppConfig } from '../core/config/config';
import { UsageRepository } from '../modules/usage/repository';
import { createBailingHubKernel } from '../app/kernel';

export type CrashStage = 'admitted' | 'dispatch' | 'result' | 'settlement';
export type CrashPoint = `${CrashStage}:${'before' | 'after'}`;
export interface CrashChildInit { type: 'init'; config: AppConfig; instanceKey: string; point?: CrashPoint }

export function transactionStage(sql: string): CrashStage | undefined {
  if (/INSERT INTO bz_usage_billing_requests\(/i.test(sql)) return 'admitted';
  if (/UPDATE bz_usage_billing_requests SET state='dispatch_committed'/i.test(sql)) return 'dispatch';
  if (/UPDATE bz_usage_billing_requests SET state=\?,result_state=\?,result_json=\?/i.test(sql)) return 'result';
  if (/INSERT INTO bz_usage_billing_ledger\(/i.test(sql)) return 'settlement';
  return undefined;
}

function installCrashBarrier(point: CrashPoint) {
  const transaction = UsageRepository.prototype.withTransaction;
  let entered = false;
  const pause = async () => {
    entered = true;
    process.send?.({ type: 'fault', point, pid: process.pid });
    await new Promise<void>(() => { /* Only SIGKILL may cross this test barrier. */ });
  };
  UsageRepository.prototype.withTransaction = function<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
    return transaction.call(this, async (connection: PoolConnection) => {
      const originalQuery = connection.query, originalCommit = connection.commit, originalRelease = connection.release;
      let stage: CrashStage | undefined;
      connection.query = (async (...args: unknown[]) => {
        const result = await (originalQuery as (...args: unknown[]) => Promise<unknown>).apply(connection, args);
        if (typeof args[0] === 'string') stage = transactionStage(args[0]) ?? stage;
        return result;
      }) as PoolConnection['query'];
      connection.commit = async () => {
        if (!entered && point === `${stage}:before`) await pause();
        await originalCommit.call(connection);
        if (!entered && point === `${stage}:after`) await pause();
      };
      connection.release = () => {
        connection.query = originalQuery;
        connection.commit = originalCommit;
        connection.release = originalRelease;
        originalRelease.call(connection);
      };
      return fn(connection);
    }) as Promise<T>;
  };
}

let initialized = false;
process.on('message', (message: CrashChildInit | { type: 'shutdown' }) => {
  if (message.type !== 'init' || initialized) return;
  initialized = true;
  void (async () => {
    if (message.point) installCrashBarrier(message.point);
    const kernel = createBailingHubKernel({ instanceKey: message.instanceKey, config: message.config,
      schedulerMode: 'managed', bootstrapLocalAdmin: false, logger: { log() {}, warn() {}, error() {} } });
    await kernel.initialize();
    const server = createServer((req, res) => { void kernel.handle(req, res).catch(error => res.destroy(error)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    process.send?.({ type: 'ready', base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, pid: process.pid });
    process.on('message', next => {
      if ((next as { type?: string }).type !== 'shutdown') return;
      void (async () => {
        server.close(); server.closeAllConnections();
        await kernel.close(5000);
        process.exit(0);
      })().catch(() => process.exit(1));
    });
  })().catch(error => {
    process.send?.({ type: 'error', message: error instanceof Error ? error.message : 'Synthetic child failed' });
    process.exit(1);
  });
});
