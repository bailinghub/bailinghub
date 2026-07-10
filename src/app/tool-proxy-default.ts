// OSS 默认工具代理包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 tool-proxy.ts 的 *For(deps) 入口。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg, cfgStore, store, toolIndex } from './runtime';
import { now, sleep } from './http';
import type { Job } from '../core/contracts/types';
import {
  handleToolDefsFor,
  handleToolInvokeFor,
  toolsForWorkItemFor,
  type ToolProxyDeps,
} from './tool-proxy';

export function defaultToolProxyDeps(): ToolProxyDeps {
  return {
    cfg,
    configStore: cfgStore,
    stateStore: store,
    toolIndex,
    now,
    sleep,
  };
}

export async function toolsForWorkItem(job: Job): Promise<Record<string, unknown> | null> {
  return toolsForWorkItemFor(defaultToolProxyDeps(), job);
}

export async function handleToolDefs(req: IncomingMessage, res: ServerResponse, jobId: string, presented: string, names: string[]): Promise<void> {
  return handleToolDefsFor(defaultToolProxyDeps(), req, res, jobId, presented, names);
}

export async function handleToolInvoke(req: IncomingMessage, res: ServerResponse, jobId: string, presented: string): Promise<void> {
  return handleToolInvokeFor(defaultToolProxyDeps(), req, res, jobId, presented);
}
