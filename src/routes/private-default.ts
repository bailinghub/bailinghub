// OSS 默认私有 HTTP 分发：这里才绑定 app/runtime 单组织单例和默认业务 handler。
// 自定义部署应 import private.ts 的 handlePrivateHttpFor(deps) 并传入自己的 deps。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg, cfgStore, kbService, store, toolIndex } from '../app/runtime';
import { handleAdminApi } from './admin-default';
import { handleApprovalDecision } from './approvals-default';
import { handleExecutorClaim, handleExecutorHeartbeat, handleExecutorResult } from './executor-default';
import { handleKbIngestFor, handleKbIngestListFor, handleKbSearchFor } from './kb';
import { handleRun } from './run-default';
import { handleSend } from './send-default';
import { handleWecomInbound } from './wecom-default';
import { handlePrivateHttpFor, type PrivateHttpDeps } from './private';

export function defaultPrivateHttpDeps(): PrivateHttpDeps {
  return {
    cfg,
    configStore: cfgStore,
    stateStore: store,
    kbService,
    toolIndex,
    handleAdminApi,
    handleApprovalDecision,
    handleExecutorClaim,
    handleExecutorHeartbeat,
    handleExecutorResult,
    handleKbSearchFor,
    handleKbIngestFor,
    handleKbIngestListFor,
    handleRun,
    handleSend,
    handleWecomInbound,
  };
}

export async function handlePrivateHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  return handlePrivateHttpFor(defaultPrivateHttpDeps(), req, res, url);
}
