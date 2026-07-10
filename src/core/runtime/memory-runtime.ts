// 会话记忆运行时：读取总账摘要/最近消息 → 渲染【会话背景】块。
// 不依赖 runtime 单例，engine 只负责传入 store/audit 与是否需要装配。
import { renderMemoryBlock, type MemoryConfig, type MsgLite } from './memory';

export interface MemoryStoreLike {
  getThreadMemory(threadId: number): Promise<{ summary: string | null; summary_upto_id: number }>;
  recentMessagesAfter(threadId: number, afterId: number, n: number): Promise<MsgLite[]>;
}

export interface MemoryInjectInput {
  dispatchInput: string;
  threadId?: number;
  enabled: boolean;
  memory: MemoryConfig;
  store?: MemoryStoreLike | null;
  audit?: (event: string, detail: Record<string, unknown>) => Promise<void>;
}

export async function injectMemoryContext(input: MemoryInjectInput): Promise<string> {
  if (!input.enabled || !input.store || input.threadId === undefined) return input.dispatchInput;
  try {
    const tm = input.memory.summary_enabled
      ? await input.store.getThreadMemory(input.threadId)
      : { summary: null, summary_upto_id: 0 };
    const recent = await input.store.recentMessagesAfter(input.threadId, tm.summary_upto_id, input.memory.recent_messages);
    const block = renderMemoryBlock(tm.summary, recent, input.memory);
    return block ? block + '\n\n' + input.dispatchInput : input.dispatchInput;
  } catch (e) {
    await input.audit?.('ledger_error', { stage: 'assemble', error: String(e) });
    return input.dispatchInput;
  }
}
