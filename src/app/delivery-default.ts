// OSS 默认送达包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 delivery.ts 的 spawnDeliveryJobFor(deps, ...)。
import { cfg, cfgStore, store } from './runtime';
import { now, sleep } from './http';
import { spawnDeliveryJobFor, type DeliveryDeps } from './delivery';
import type { Job } from '../core/contracts/types';

export function defaultDeliveryDeps(): DeliveryDeps {
  return { cfg, configStore: cfgStore, stateStore: store, now, sleep };
}

export async function spawnDeliveryJob(parent: Job): Promise<void> {
  return spawnDeliveryJobFor(defaultDeliveryDeps(), parent);
}
