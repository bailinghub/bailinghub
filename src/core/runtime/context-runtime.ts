// 上下文装配运行时：把原始用户输入、安全清洗、记忆、页面、知识、权限与多模态资产组装成最终 dispatch input。
// 本模块不依赖 runtime 单例；engine 只负责传入 store/service/audit，并决定本轮是否需要记忆装配。
import { extractAudioUrls, extractFileRefs, extractImageUrls, type FileRef } from '../platform/content';
import { stripFenceTokens } from '../platform/fence';
import { injectKnowledgeContext, type KnowledgeServiceLike } from './knowledge-runtime';
import { injectMemoryContext, type MemoryStoreLike } from './memory-runtime';
import type { MemoryConfig } from './memory';
import { type ResolvedPage, renderPageContextBlock } from '../platform/pagecontext';
import type { Job, Route } from '../contracts/types';

export type ContextAudit = (event: string, detail: Record<string, unknown>) => Promise<void>;

export interface DispatchContextInput {
  route: Route | null;
  metadata: Record<string, unknown>;
  fullInput: string;
  requestId: string;
  permission?: string;
  safeInput?: string;
  threadId?: number;
  memory: MemoryConfig;
  memoryEnabled: boolean;
  memoryStore?: MemoryStoreLike | null;
  knowledgeService?: KnowledgeServiceLike | null;
  audit?: ContextAudit;
}

export interface DispatchContextResult {
  safeInput: string;
  dispatchInput: string;
  kbRefs?: NonNullable<Job['dispatch']>['kb_refs'];
  userImages: string[];
  userAudio: string[];
  userFiles: FileRef[];
}

export function sanitizeUserInput(fullInput: string): string {
  return stripFenceTokens(fullInput);
}

/**
 * 权限档 → 前置提示词。中枢只"以提示词指导"执行器该做到什么程度，不做硬性沙箱强制
 * （执行器是否遵守由其自身决定，这一层的责任在执行器侧，不在中枢）。
 * 'full' 或空 → 不加任何前置（不限制）。返回空串表示不注入。
 */
export function permissionPreamble(permission?: string): string {
  switch (permission) {
    case 'readonly':
      return '【本次任务权限：只读】你只能查询、读取、检索、分析与汇报。禁止创建/修改/删除任何文件、数据或配置，禁止执行任何有副作用或不可逆的操作（写库、发消息、提交代码、改远端状态等）。若任务需要写操作，请说明需要做什么并交还给人，不要自行执行。';
    case 'readwrite':
      return '【本次任务权限：可写】允许读取与常规修改（改文件、产出内容、普通写操作）。但删除、对外发送、批量或不可逆的变更请谨慎，非必要不执行；不确定时先说明再做。';
    default:
      return '';
  }
}

export async function assembleDispatchContext(input: DispatchContextInput): Promise<DispatchContextResult> {
  const safeInput = input.safeInput ?? sanitizeUserInput(input.fullInput);
  let dispatchInput = safeInput;

  dispatchInput = await injectMemoryContext({
    dispatchInput,
    threadId: input.threadId,
    enabled: input.memoryEnabled,
    memory: input.memory,
    store: input.memoryStore,
    audit: input.audit,
  });

  const pageBlock = renderPageContextBlock(input.metadata['page_context'] as ResolvedPage | undefined);
  if (pageBlock) dispatchInput = pageBlock + '\n\n' + dispatchInput;

  const injected = await injectKnowledgeContext({
    route: input.route,
    metadata: input.metadata,
    fullInput: input.fullInput,
    requestId: input.requestId,
    dispatchInput,
    kbService: input.knowledgeService,
    audit: input.audit,
  });
  dispatchInput = injected.dispatchInput;

  const permPreamble = permissionPreamble(input.permission);
  if (permPreamble) dispatchInput = permPreamble + '\n\n' + dispatchInput;

  return {
    safeInput,
    dispatchInput,
    kbRefs: injected.kbRefs,
    userImages: extractImageUrls(input.fullInput),
    userAudio: extractAudioUrls(input.fullInput),
    userFiles: extractFileRefs(input.fullInput),
  };
}
