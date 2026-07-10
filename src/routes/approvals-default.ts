// OSS 默认审批决策回调包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 approvals.ts 的 handleApprovalDecisionFor(deps, ...)。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg, cfgStore, store } from '../app/runtime';
import { now, sleep } from '../app/http';
import { requeueForRerun } from '../app/engine-default';
import { outboundRuntimeDepsFor, secretForJobWithDeps } from '../app/outbound';
import type { Job } from '../core/contracts/types';
import { handleApprovalDecisionFor, type ApprovalDecisionDeps } from './approvals';

export function defaultApprovalDecisionDeps(): ApprovalDecisionDeps {
  const outboundDeps = outboundRuntimeDepsFor({
    cfg,
    configStore: cfgStore,
    stateStore: store,
    now,
    sleep,
  });
  return {
    cfg,
    configStore: cfgStore,
    stateStore: store,
    now,
    sleep,
    secretForJob: (job: Job): Promise<string> => secretForJobWithDeps(outboundDeps, job),
    engineRuntime: { requeueForRerun },
  };
}

export async function handleApprovalDecision(req: IncomingMessage, res: ServerResponse, approvalId: number, url: URL): Promise<void> {
  return handleApprovalDecisionFor(defaultApprovalDecisionDeps(), req, res, approvalId, url);
}
