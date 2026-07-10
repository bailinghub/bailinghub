// OSS 默认工具审批包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 tool-approvals.ts 的 For/Stores 入口。
import { cfg, cfgStore, store } from './runtime';
import { now, sleep } from './http';
import { approvedNoteForJobFor, approvalDepsForStores } from './tool-approvals';
import type { ApprovalDeps } from '../core/contracts/tools';
import type { Job, ToolProvider } from '../core/contracts/types';
import type { RouteToolsConfig, ToolSourceConfig } from '../core/config/tools-config';

export async function approvedNoteForJob(jobId: string): Promise<string | undefined> {
  return approvedNoteForJobFor(cfgStore, jobId);
}

export function approvalDepsFor(job: Job, provider: ToolProvider, toolsCfg: RouteToolsConfig, sourceCfg: ToolSourceConfig): ApprovalDeps | undefined {
  return approvalDepsForStores(cfgStore, store, job, provider, toolsCfg, sourceCfg, cfg, now, sleep);
}
