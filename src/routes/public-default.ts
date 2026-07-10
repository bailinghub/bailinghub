// OSS 默认公开 HTTP 分发：这里才绑定 app/runtime 单组织单例和默认聊天入口。
// 自定义部署应 import public.ts 的 handlePublicHttpFor(deps) 并传入自己的 deps。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg, cfgStore, edition, isPaused, queue } from '../app/runtime';
import { serveConsoleFromRoot } from '../app/http';
import { handleChat, handleChatConfig, handleChatEvents, handleChatRate, handleChatThread, handleChatUpload, serveChatDemo } from './chat-default';
import { handlePublicHttpFor, type PublicHttpDeps } from './public';
import { checkReadinessFor } from '../app/readiness';

export function defaultPublicHttpDeps(): PublicHttpDeps {
  return {
    cfg,
    configStore: cfgStore,
    queue,
    isPaused,
    readiness: () => checkReadinessFor(cfg, cfgStore),
    operationalStatus: () => {
      const audit = edition.auditFailures.snapshot();
      return { audit_write_failures: audit.total, last_audit_failure_at: audit.lastFailureAt };
    },
    serveConsole: (urlPath, res, head) => serveConsoleFromRoot(cfg.root, urlPath, res, head),
    handleChat,
    handleChatConfig,
    handleChatEvents,
    handleChatThread,
    handleChatUpload,
    handleChatRate,
    serveChatDemo,
  };
}

export async function handlePublicHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  return handlePublicHttpFor(defaultPublicHttpDeps(), req, res, url);
}
