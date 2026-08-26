import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationLedger } from './config-conversation-ledger';

test('ConversationLedger 会话列表把 agent:<app_id> 关联到接入方名称', async () => {
  let sql = '';
  const ledger = new ConversationLedger(() => ({
    query: async (statement: string) => { sql = statement; return [[]]; },
  }));
  assert.deepEqual(await ledger.listRecentThreads(), []);
  assert.match(sql, /m\.channel=CONCAT\('agent:',c\.app_id\)/);
});

test('ConversationLedger 会话详情同样识别智能体客户端来源', async () => {
  const statements: string[] = [];
  const ledger = new ConversationLedger(() => ({
    query: async (statement: string) => { statements.push(statement); return [[]]; },
  }));
  assert.equal(await ledger.threadDetail(7), null);
  assert.match(statements[0] ?? '', /m\.channel=CONCAT\('agent:',c\.app_id\)/);
});
