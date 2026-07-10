// OSS 默认工具源巡检/刷新包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 tool-specs.ts 的 For 入口并显式传入当前 scope 依赖。
import { cfg, cfgStore, store, toolIndex } from './runtime';
import { now, sleep } from './http';
import {
  probeAuthorizeFor,
  refreshProviderSpecFor,
  reindexToolProviderIndexFor,
  retrievalProbeFor,
  runSpecAutoRefreshFor,
  type AuthzProbeResult,
} from './tool-specs';
import type { ToolProvider } from '../core/contracts/types';

export async function refreshProviderSpec(p: ToolProvider, via: 'manual' | 'auto'): Promise<{ tools: number; added: string[]; removed: string[]; changed: string[] }> {
  return refreshProviderSpecFor(cfgStore, store, toolIndex, p, via, cfg, now, sleep);
}

export async function reindexToolProviderIndex(p: ToolProvider): Promise<{ added: string[]; changed: string[]; removed: string[]; unchanged: number; total: number } | null> {
  return reindexToolProviderIndexFor(store, toolIndex, p, now);
}

export async function retrievalProbe(p: ToolProvider, query: string, k = 30): Promise<{ enabled: boolean; min_score_default: number; hits: Array<{ name: string; scope: string; score: number }> }> {
  return retrievalProbeFor(toolIndex, p, query, k);
}

export async function probeAuthorize(p: ToolProvider): Promise<AuthzProbeResult> {
  return probeAuthorizeFor(cfgStore, store, p, cfg, now, sleep);
}

export async function runSpecAutoRefresh(): Promise<void> {
  await runSpecAutoRefreshFor(cfgStore, store, toolIndex, cfg, now, sleep);
}
