// OSS 默认进程也走公开 Kernel Host API，确保独立部署与外部宿主复用同一条装配路径。
import { createBailingHubKernel } from './app/kernel';
import { loadConfig } from './core/config/config';

const kernel = createBailingHubKernel({
  instanceKey: 'oss:default',
  config: loadConfig(),
  schedulerMode: 'standalone',
});
const appServer = kernel.createStandaloneServer();

await appServer.start();
appServer.registerSignalHandlers();
