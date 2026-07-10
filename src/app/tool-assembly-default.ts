// OSS 默认工具装配包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 tool-assembly.ts 的 assembleToolRuntimeFor(deps...)。
import { cfg, cfgStore, store, toolIndex } from './runtime';
import { now, sleep } from './http';
import { assembleToolRuntimeFor } from './tool-assembly';
import type { ToolRuntime } from '../core/contracts/tools';
import type { Job, Route } from '../core/contracts/types';

export async function assembleToolRuntime(job: Job, route: Route | null): Promise<ToolRuntime | 'subject_locked' | undefined> {
  return assembleToolRuntimeFor(cfgStore, store, toolIndex, job, route, cfg, now, sleep);
}
