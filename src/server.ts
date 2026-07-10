// server.ts = OSS 默认进程入口：把开源版 runtime 注入通用 HTTP 服务组合器。
// 这里保持极薄，避免扩展发行版为了替换 edition/store/scope 而复制整套 HTTP 启动逻辑。
import { cfg, cfgStore, queue } from './app/runtime';
import { createBailingHttpServer } from './app/http-server';
import { handlePrivateHttp } from './routes/private-default';
import { handlePublicHttp } from './routes/public-default';
import { initializeRuntimeLifecycle, scheduleBootRecovery, startRuntimeSchedulers } from './app/runtime-lifecycle-default';

const appServer = createBailingHttpServer({
  cfg,
  configStore: cfgStore,
  queue,
  handlePublicHttp,
  handlePrivateHttp,
  initializeRuntimeLifecycle,
  startRuntimeSchedulers,
  scheduleBootRecovery,
});

await appServer.start();
appServer.registerSignalHandlers();
