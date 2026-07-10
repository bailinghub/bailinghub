// OSS 默认外发包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 outbound.ts 的 WithDeps/For 入口并显式传入当前 scope 账本。
import { cfg, cfgStore, store } from './runtime';
import { now, sleep } from './http';
import {
  fireCallbackWithDeps,
  outboundRuntimeDepsFor,
  postSignedWithDeps,
  secretForJobWithDeps,
  sendAlertWithDeps,
  type OutboundRuntimeDeps,
} from './outbound';
import type { Job } from '../core/contracts/types';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export function defaultOutboundRuntimeDeps(): OutboundRuntimeDeps {
  return outboundRuntimeDepsFor({
    cfg,
    configStore: cfgStore,
    stateStore: store,
    now,
    sleep,
  });
}

export async function secretForJobFor(config: ConfigStoreContract | null, job: Job): Promise<string> {
  return secretForJobWithDeps(outboundRuntimeDepsFor({ cfg, configStore: config, stateStore: store, now, sleep }), job);
}

export async function secretForJob(job: Job): Promise<string> {
  return secretForJobWithDeps(defaultOutboundRuntimeDeps(), job);
}

export async function postSignedFor(state: RuntimeStateStore, url: string, payload: unknown, secret: string, audit: { job_id: string; request_id: string; event: string }): Promise<boolean> {
  return postSignedWithDeps(outboundRuntimeDepsFor({ cfg, configStore: cfgStore, stateStore: state, now, sleep }), url, payload, secret, audit);
}

export async function postSigned(url: string, payload: unknown, secret: string, audit: { job_id: string; request_id: string; event: string }): Promise<boolean> {
  return postSignedWithDeps(defaultOutboundRuntimeDeps(), url, payload, secret, audit);
}

export async function fireCallbackFor(config: ConfigStoreContract | null, state: RuntimeStateStore, url: string, job: Job): Promise<void> {
  await fireCallbackWithDeps(outboundRuntimeDepsFor({ cfg, configStore: config, stateStore: state, now, sleep }), url, job);
}

export async function fireCallback(url: string, job: Job): Promise<void> {
  await fireCallbackWithDeps(defaultOutboundRuntimeDeps(), url, job);
}

export async function sendAlertFor(config: ConfigStoreContract | null, state: RuntimeStateStore, key: string, text: string): Promise<void> {
  await sendAlertWithDeps(outboundRuntimeDepsFor({ cfg, configStore: config, stateStore: state, now, sleep }), key, text);
}

export async function sendAlert(key: string, text: string): Promise<void> {
  await sendAlertWithDeps(defaultOutboundRuntimeDeps(), key, text);
}
