// OSS 默认聊天入口包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 chat.ts 的 *For(deps) 入口。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg, isPaused, jobStream } from '../app/runtime';
import { resolveProjectPathFor, runtimeContextFor, runtimeStoresFor } from '../app/runtime-context-default';
import { now } from '../app/http';
import type { EngineRuntime } from '../app/engine';
import { launchJob } from '../app/engine-default';
import type { RuntimeContext } from '../core/edition';
import {
  handleChatConfigFor,
  handleChatFor,
  handleChatRateFor,
  handleChatEventsFor,
  handleChatThreadFor,
  handleChatUploadFor,
  serveChatDemoFor,
  type ChatApiDeps,
} from './chat';

export function defaultChatApiDeps(): ChatApiDeps {
  return {
    cfg,
    isPaused,
    runtimeContextFor,
    runtimeStoresFor,
    resolveProjectPathFor,
    now,
    jobStream,
    engineForContext: (_ctx: RuntimeContext): Pick<EngineRuntime, 'launchJob'> => ({ launchJob }),
  };
}

export async function handleChat(req: IncomingMessage, res: ServerResponse, entryKey: string): Promise<void> {
  return handleChatFor(defaultChatApiDeps(), req, res, entryKey);
}

export async function handleChatEvents(req: IncomingMessage, res: ServerResponse, entryKey: string, jobId: string, url: URL): Promise<void> {
  return handleChatEventsFor(defaultChatApiDeps(), req, res, entryKey, jobId, url);
}

export async function handleChatThread(req: IncomingMessage, res: ServerResponse, entryKey: string, url: URL): Promise<void> {
  return handleChatThreadFor(defaultChatApiDeps(), req, res, entryKey, url);
}

export async function handleChatUpload(req: IncomingMessage, res: ServerResponse, entryKey: string): Promise<void> {
  return handleChatUploadFor(defaultChatApiDeps(), req, res, entryKey);
}

export async function handleChatRate(req: IncomingMessage, res: ServerResponse, entryKey: string, jobId: string): Promise<void> {
  return handleChatRateFor(defaultChatApiDeps(), req, res, entryKey, jobId);
}

export async function handleChatConfig(req: IncomingMessage, res: ServerResponse, entryKey: string): Promise<void> {
  return handleChatConfigFor(defaultChatApiDeps(), req, res, entryKey);
}

export function serveChatDemo(res: ServerResponse, entryKey: string): void {
  return serveChatDemoFor(defaultChatApiDeps(), res, entryKey);
}
