// OSS 默认自监控包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 monitor.ts 的 runMonitorFor(deps...)。
import { cfg, cfgStore, isPaused, store } from './runtime';
import { now, sleep } from './http';
import { runMonitorFor } from './monitor';

export async function runMonitor(): Promise<void> {
  await runMonitorFor(cfgStore, store, isPaused, cfg, now, sleep);
}
