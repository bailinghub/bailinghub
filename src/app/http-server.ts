// HTTP 服务组合器：只接收依赖，不读取 config.json，也不绑定 OSS 单例。
// server.ts 使用这里创建开源版默认进程；扩展发行版可复用同一入口传入自己的 runtime composition。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../core/config/config';
import { PayloadTooLargeError, send } from './http';
import type { RuntimeSchedulers } from './runtime-lifecycle';

export interface BailingHttpServerDeps {
  cfg: AppConfig;
  configStore: unknown | null;
  queue: { drain(ms: number): Promise<boolean> };
  handlePublicHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  handlePrivateHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
  initializeRuntimeLifecycle(): Promise<void>;
  startRuntimeSchedulers(): RuntimeSchedulers;
  scheduleBootRecovery(): ReturnType<typeof setTimeout>;
  shutdownDrainMs?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  exit?: (code: number) => void;
}

export interface BailingHttpServer {
  server: Server;
  start(): Promise<void>;
  shutdown(signal: NodeJS.Signals | 'test'): Promise<void>;
  registerSignalHandlers(): void;
  isShuttingDown(): boolean;
}

const DEFAULT_SHUTDOWN_DRAIN_MS = Number(process.env.BAILING_SHUTDOWN_DRAIN_MS ?? 30_000) || 30_000;

export function createBailingHttpServer(deps: BailingHttpServerDeps): BailingHttpServer {
  const logger = deps.logger ?? console;
  const shutdownDrainMs = deps.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS;
  let shuttingDown = false;
  let schedulers: RuntimeSchedulers | null = null;
  let bootRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

  const server = createServer(async (req, res) => {
    let requestPath = '/';
    try {
      if (shuttingDown) {
        send(res, 503, { error: 'server shutting down' });
        return;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      requestPath = url.pathname;
      if (await deps.handlePublicHttp(req, res, url)) return;
      await deps.handlePrivateHttp(req, res, url);
    } catch (e) {
      if (e instanceof PayloadTooLargeError) send(res, 413, { error: 'payload too large', max_bytes: e.maxBytes });
      else {
        const requestId = randomUUID();
        logger.error('[百灵中枢] HTTP 未捕获异常', {
          request_id: requestId,
          method: req.method ?? 'GET',
          path: requestPath,
          error: e instanceof Error
            ? { name: e.name, message: e.message, stack: e.stack }
            : { name: 'UnknownError', message: String(e) },
        });
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.setHeader('x-request-id', requestId);
        send(res, 500, { error: 'internal_error', request_id: requestId });
      }
    }
  });

  async function start(): Promise<void> {
    await deps.initializeRuntimeLifecycle();
    schedulers = deps.startRuntimeSchedulers();
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => {
        server.off('listening', onListening);
        reject(e);
      };
      const onListening = (): void => {
        server.off('error', onError);
        logger.log(`[百灵中枢] bailinghub runner 监听 http://${deps.cfg.server.host}:${deps.cfg.server.port}  backend=${deps.cfg.state.backend}  并发=${deps.cfg.concurrency}  时区=${deps.cfg.displayTz}  配置后台=${deps.configStore ? 'on (/admin)' : 'off'}`);
        bootRecoveryTimer = deps.scheduleBootRecovery();
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(deps.cfg.server.port, deps.cfg.server.host);
    });
  }

  async function shutdown(signal: NodeJS.Signals | 'test'): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`[百灵中枢] 收到 ${signal}，停止接收新请求并等待在途任务收尾`);
    schedulers?.stop();
    if (bootRecoveryTimer) clearTimeout(bootRecoveryTimer);
    server.closeIdleConnections?.();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const drained = await deps.queue.drain(shutdownDrainMs).catch(() => false);
    if (!drained) logger.warn(`[百灵中枢] 优雅停机等待 ${shutdownDrainMs}ms 后仍有在途任务，交由 DB lease/reaper 恢复`);
    await closed;
    (deps.exit ?? process.exit)(0);
  }

  function registerSignalHandlers(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void shutdown(signal).catch((e) => {
          logger.error('[百灵中枢] 停机流程异常', e);
          (deps.exit ?? process.exit)(1);
        });
      });
    }
  }

  return {
    server,
    start,
    shutdown,
    registerSignalHandlers,
    isShuttingDown: () => shuttingDown,
  };
}
