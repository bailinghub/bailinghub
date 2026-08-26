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

test('ConversationLedger 会话详情分别保留旧 job_id 与 Agent Client agent_run_id', async () => {
  const statements: string[] = [];
  const ledger = new ConversationLedger(() => ({
    query: async (statement: string) => {
      statements.push(statement);
      if (statements.length === 1) {
        return [[{
          thread_id: 7,
          route_key: 'tenant-agent',
          route_name: '门店助手',
          scope_key: 'agent:scope',
          principal_id: 'user-7',
          message_count: 3,
          created_at: '2026-08-26T00:00:00.000Z',
          last_active_at: '2026-08-26T00:01:00.000Z',
          summary: null,
        }]];
      }
      return [[
        {
          id: 1, direction: 'out', channel: 'hub', principal_id: null,
          job_id: '123e4567-e89b-42d3-a456-426614174000', agent_run_id: null,
          content: '旧任务回复', created_at: '2026-08-26T00:00:10.000Z',
        },
        {
          id: 2, direction: 'in', channel: 'agent:digital-cloud', principal_id: 'user-7',
          job_id: null, agent_run_id: '223e4567-e89b-42d3-a456-426614174000',
          content: '修改员工资料', created_at: '2026-08-26T00:00:20.000Z',
        },
        {
          id: 3, direction: 'out', channel: 'hub', principal_id: null,
          job_id: null, agent_run_id: '223e4567-e89b-42d3-a456-426614174000',
          content: '已完成修改', created_at: '2026-08-26T00:00:30.000Z',
        },
      ]];
    },
  }));

  const detail = await ledger.threadDetail(7);
  assert.ok(detail);
  assert.match(statements[1] ?? '', /job_id,agent_run_id/);
  assert.equal(detail.messages[0].job_id, '123e4567-e89b-42d3-a456-426614174000');
  assert.equal(detail.messages[0].agent_run_id, null);
  assert.equal(detail.messages[1].job_id, null);
  assert.equal(detail.messages[1].agent_run_id, '223e4567-e89b-42d3-a456-426614174000');
  assert.equal(detail.messages[2].agent_run_id, detail.messages[1].agent_run_id);
});
