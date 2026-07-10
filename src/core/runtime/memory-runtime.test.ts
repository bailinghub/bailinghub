// 覆盖：会话记忆注入运行时。总账读取失败必须降级，不阻塞任务执行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMemoryConfig } from './memory';
import { injectMemoryContext, type MemoryStoreLike } from './memory-runtime';

test('injectMemoryContext: 未启用、无 store 或无 thread 时不改输入', async () => {
  const memory = resolveMemoryConfig();
  assert.equal(await injectMemoryContext({ dispatchInput: '原文', enabled: false, memory }), '原文');
  assert.equal(await injectMemoryContext({ dispatchInput: '原文', enabled: true, memory, threadId: 1 }), '原文');
  assert.equal(await injectMemoryContext({ dispatchInput: '原文', enabled: true, memory, store: {} as MemoryStoreLike }), '原文');
});

test('injectMemoryContext: 摘要关闭时只读取最近消息并注入会话背景', async () => {
  const store: MemoryStoreLike = {
    async getThreadMemory() {
      throw new Error('summary_enabled=false 时不应读取摘要');
    },
    async recentMessagesAfter(threadId, afterId, n) {
      assert.equal(threadId, 9);
      assert.equal(afterId, 0);
      assert.equal(n, 2);
      return [
        { direction: 'in', channel: 'chat:demo', content: '之前的问题', created_at: '2026-07-01T00:00:00.000Z' },
        { direction: 'out', channel: 'hub', content: '之前的回答', created_at: '2026-07-01T00:01:00.000Z' },
      ];
    },
  };

  const got = await injectMemoryContext({
    dispatchInput: '本轮问题',
    enabled: true,
    threadId: 9,
    memory: resolveMemoryConfig({ recent_messages: 2 }),
    store,
  });

  assert.match(got, /【会话背景】/);
  assert.match(got, /之前的问题/);
  assert.match(got, /本轮问题/);
});

test('injectMemoryContext: 摘要开启时读取摘要水位并从水位后取最近消息', async () => {
  const store: MemoryStoreLike = {
    async getThreadMemory(threadId) {
      assert.equal(threadId, 10);
      return { summary: '早期摘要', summary_upto_id: 5 };
    },
    async recentMessagesAfter(threadId, afterId) {
      assert.equal(threadId, 10);
      assert.equal(afterId, 5);
      return [{ direction: 'out', channel: 'hub', content: '水位后的回复', created_at: '2026-07-01T00:02:00.000Z' }];
    },
  };

  const got = await injectMemoryContext({
    dispatchInput: '本轮问题',
    enabled: true,
    threadId: 10,
    memory: resolveMemoryConfig({ summary_enabled: true }),
    store,
  });

  assert.match(got, /早期摘要/);
  assert.match(got, /水位后的回复/);
});

test('injectMemoryContext: 总账异常时审计并返回原输入', async () => {
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const got = await injectMemoryContext({
    dispatchInput: '原文',
    enabled: true,
    threadId: 11,
    memory: resolveMemoryConfig({ summary_enabled: true }),
    store: {
      async getThreadMemory() { throw new Error('db down'); },
      async recentMessagesAfter() { return []; },
    },
    audit: async (event, detail) => { audits.push({ event, detail }); },
  });

  assert.equal(got, '原文');
  assert.equal(audits[0]?.event, 'ledger_error');
  assert.equal(audits[0]?.detail['stage'], 'assemble');
});
